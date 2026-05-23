const nodeMajorVersion = Number(String(process.versions.node || '').split('.')[0]);
if (!Number.isInteger(nodeMajorVersion) || nodeMajorVersion < 18) {
    console.error('LAN Quick Transfer requires Node.js 18 or later.');
    console.error(`Current Node.js version: ${process.versions.node || 'unknown'}`);
    console.error('Please upgrade Node.js, then run start_server.bat again.');
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const app = express();
const fsp = fs.promises;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 18082;
const RESERVED_PORTS = new Set([18080, 18081]);
const AUTO_PORT_SCAN_LIMIT = 50;
const PROJECT_ROOT = __dirname;
const UPLOADS_DIR = process.env.LAN_QT_UPLOADS_DIR
    ? path.resolve(process.env.LAN_QT_UPLOADS_DIR)
    : path.join(PROJECT_ROOT, 'uploads');
const DATA_DIR = process.env.LAN_QT_DATA_DIR
    ? path.resolve(process.env.LAN_QT_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'server-config.json');
const STATUS_FILE = path.join(DATA_DIR, 'server-status.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const UPLOAD_SESSIONS_DIR = path.join(DATA_DIR, 'upload-sessions');
const MAX_FILE_SIZE = 1024 * 1024 * 1024 * 1024 * 1024; // 1PB, effectively unlimited
const CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 0; // 0 means no automatic deletion by default
const DEFAULT_MAX_STORAGE_BYTES = 0; // 0 means unlimited by default
const AUTO_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const DEVICE_LAST_SEEN_SAVE_INTERVAL_MS = 30 * 1000;
const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 20000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 120;
const MAX_RELATIVE_PATH_LENGTH = 1000;

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_SESSIONS_DIR)) fs.mkdirSync(UPLOAD_SESSIONS_DIR, { recursive: true });

function isValidBindHost(host) {
    if (host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost') {
        return true;
    }

    const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
    return ipv4Pattern.test(host);
}

function normalizePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || RESERVED_PORTS.has(port)) {
        return DEFAULT_PORT;
    }
    return port;
}

function saveServerConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function normalizeStorageConfig(storage) {
    const retentionDays = Number(storage && storage.retentionDays);
    const maxStorageBytes = Number(storage && storage.maxStorageBytes);

    return {
        retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0
            ? Math.floor(retentionDays)
            : DEFAULT_RETENTION_DAYS,
        maxStorageBytes: Number.isFinite(maxStorageBytes) && maxStorageBytes >= 0
            ? Math.floor(maxStorageBytes)
            : DEFAULT_MAX_STORAGE_BYTES,
        autoCleanupEnabled: storage && storage.autoCleanupEnabled !== false
    };
}

function loadServerConfig() {
    const defaults = {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        storage: normalizeStorageConfig({})
    };

    if (!fs.existsSync(CONFIG_FILE)) {
        saveServerConfig(defaults);
        return defaults;
    }

    try {
        const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(rawConfig);
        const host = typeof parsed.host === 'string' && isValidBindHost(parsed.host.trim())
            ? parsed.host.trim()
            : DEFAULT_HOST;
        const port = normalizePort(parsed.port);
        const normalized = {
            host,
            port,
            storage: normalizeStorageConfig(parsed.storage)
        };
        saveServerConfig(normalized);
        return normalized;
    } catch (e) {
        console.error('Failed to load server config, using defaults.', e);
        saveServerConfig(defaults);
        return defaults;
    }
}

function removeStatusFile() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            fs.unlinkSync(STATUS_FILE);
        } catch (e) {
            console.error('Failed to remove status file.', e);
        }
    }
}

function writeStatusFile(data) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadDeviceData() {
    const defaults = {
        aliases: {},
        devices: {}
    };

    if (!fs.existsSync(DEVICES_FILE)) {
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(defaults, null, 2), 'utf8');
        return defaults;
    }

    try {
        const raw = fs.readFileSync(DEVICES_FILE, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        return {
            aliases: parsed && typeof parsed.aliases === 'object' && parsed.aliases ? parsed.aliases : {},
            devices: parsed && typeof parsed.devices === 'object' && parsed.devices ? parsed.devices : {}
        };
    } catch (e) {
        console.error('Failed to load device data, using defaults.', e);
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(defaults, null, 2), 'utf8');
        return defaults;
    }
}

function saveDeviceData() {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceData, null, 2), 'utf8');
}

const serverConfig = loadServerConfig();
const HOST = serverConfig.host;
let PORT = serverConfig.port;
let storageConfig = serverConfig.storage;

// State
let chatHistory = [];
const deviceData = loadDeviceData();
const sseClients = new Set();

// Load history
if (fs.existsSync(HISTORY_FILE)) {
    try {
        chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
        console.error("Failed to load history", e);
    }
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2), 'utf8');
}

function normalizeClientIp(value) {
    let ip = String(value || '').trim();
    if (!ip) {
        return '';
    }

    if (ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }

    if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    if (ip === '::1') {
        return '127.0.0.1';
    }

    return ip;
}

function getRequestIp(req) {
    return normalizeClientIp(
        req.socket.remoteAddress ||
        req.ip
    );
}

function getDeviceAlias(ip) {
    return ip ? String(deviceData.aliases[ip] || '').trim() : '';
}

function buildDisplaySender(message) {
    const alias = getDeviceAlias(message.ip);
    const baseName = alias || message.sender || message.clientName || '未知设备';
    return message.ip ? `${baseName} [${message.ip}]` : baseName;
}

function formatMessage(message) {
    return {
        ...message,
        displaySender: buildDisplaySender(message),
        deviceAlias: getDeviceAlias(message.ip)
    };
}

function rememberDevice(ip, clientName) {
    if (!ip) {
        return;
    }

    const safeClientName = normalizeText(clientName, MAX_CLIENT_NAME_LENGTH);
    const existing = deviceData.devices[ip] || {
        clientNames: [],
        lastSeen: null
    };
    const now = Date.now();
    const lastSeenMs = existing.lastSeen ? new Date(existing.lastSeen).getTime() : 0;
    let shouldSave = !deviceData.devices[ip];

    if (safeClientName && !existing.clientNames.includes(safeClientName)) {
        existing.clientNames.push(safeClientName);
        shouldSave = true;
    }

    if (!Number.isFinite(lastSeenMs) || now - lastSeenMs >= DEVICE_LAST_SEEN_SAVE_INTERVAL_MS) {
        existing.lastSeen = new Date(now).toISOString();
        shouldSave = true;
    }

    deviceData.devices[ip] = existing;
    if (shouldSave) {
        saveDeviceData();
    }
}

function getKnownDevices() {
    return Object.entries(deviceData.devices)
        .map(([ip, info]) => ({
            ip,
            alias: getDeviceAlias(ip),
            clientNames: Array.isArray(info.clientNames) ? info.clientNames : [],
            lastSeen: info.lastSeen || null
        }))
        .sort((a, b) => {
            const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
            const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
            return bTime - aTime;
        });
}

function getAvailableUrls() {
    const ips = getLocalIPs();
    const urls = [];

    if (HOST === '0.0.0.0') {
        urls.push(`http://127.0.0.1:${PORT}`);
        ips.forEach(ip => urls.push(`http://${ip}:${PORT}`));
    } else if (HOST === 'localhost') {
        urls.push(`http://localhost:${PORT}`);
    } else {
        urls.push(`http://${HOST}:${PORT}`);
    }

    return {
        ips,
        urls: [...new Set(urls)]
    };
}

function getPortProbeHost(host) {
    return host === 'localhost' ? '127.0.0.1' : host;
}

function getPortCandidates(preferredPort) {
    const candidates = [];
    const addCandidate = (port) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535 || RESERVED_PORTS.has(port) || candidates.includes(port)) {
            return;
        }
        candidates.push(port);
    };

    addCandidate(preferredPort);

    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + AUTO_PORT_SCAN_LIMIT; port += 1) {
        addCandidate(port);
    }

    return candidates;
}

function canListenOnPort(host, port) {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.unref();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, getPortProbeHost(host));
    });
}

async function resolveRuntimePort() {
    const candidates = getPortCandidates(serverConfig.port);

    for (const port of candidates) {
        if (await canListenOnPort(HOST, port)) {
            if (serverConfig.port !== port) {
                serverConfig.port = port;
                saveServerConfig(serverConfig);
            }
            return port;
        }
    }

    throw new Error(`No available port was found from ${DEFAULT_PORT} to ${DEFAULT_PORT + AUTO_PORT_SCAN_LIMIT - 1}.`);
}

function getPreferredConnectUrl() {
    const info = getAvailableUrls();
    return info.urls.find(url => !url.includes('127.0.0.1') && !url.includes('localhost')) || info.urls[0] || '';
}

function getOnlineDevices() {
    return Array.from(sseClients)
        .map(client => ({
            ip: client.ip,
            clientName: client.clientName || '未知设备',
            alias: getDeviceAlias(client.ip),
            connectedAt: client.connectedAt
        }))
        .sort((a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime());
}

function sanitizeUploadKey(value) {
    const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return normalized.slice(0, 120) || crypto.randomBytes(12).toString('hex');
}

function normalizeText(value, maxLength) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function decodeOriginalName(value) {
    try {
        return Buffer.from(String(value || ''), 'latin1').toString('utf8');
    } catch (e) {
        return String(value || '');
    }
}

function getSafeStoredFileName(originalName) {
    const ext = path.extname(path.basename(originalName || '')).slice(0, 32);
    return crypto.randomBytes(16).toString('hex') + ext;
}

function resolveUploadedFilePath(fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || safeName !== fileName || safeName.includes('/') || safeName.includes('\\')) {
        return null;
    }

    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const filePath = path.resolve(uploadsRoot, safeName);
    if (filePath !== uploadsRoot && filePath.startsWith(uploadsRoot + path.sep)) {
        return filePath;
    }

    return null;
}

function sanitizeDownloadName(value, fallback) {
    const name = normalizeText(value || fallback, MAX_FILE_NAME_LENGTH).replace(/[\\/]/g, '_');
    return name || fallback || 'download';
}

function isLocalDownloadUrl(value) {
    const url = String(value || '').trim();
    return !url || /^\/api\/chat\/download\/[^/?#]+(?:\?[^#]*)?$/.test(url);
}

function getUploadSessionDir(uploadKey) {
    return path.join(UPLOAD_SESSIONS_DIR, sanitizeUploadKey(uploadKey));
}

function getUploadMetaPath(uploadKey) {
    return path.join(getUploadSessionDir(uploadKey), 'meta.json');
}

function getChunkPath(uploadKey, chunkIndex) {
    return path.join(getUploadSessionDir(uploadKey), `${chunkIndex}.part`);
}

function getExpectedChunkSize(meta, chunkIndex) {
    if (meta.fileSize === 0) {
        return 0;
    }

    if (chunkIndex === meta.totalChunks - 1) {
        return meta.fileSize - (CHUNK_SIZE * (meta.totalChunks - 1));
    }

    return CHUNK_SIZE;
}

function ensureUploadSessionDir(uploadKey) {
    const sessionDir = getUploadSessionDir(uploadKey);
    fs.mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
}

function loadUploadMeta(uploadKey) {
    const metaPath = getUploadMetaPath(uploadKey);
    if (!fs.existsSync(metaPath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
        console.error('Failed to load upload meta:', uploadKey, e);
        return null;
    }
}

function saveUploadMeta(uploadKey, meta) {
    ensureUploadSessionDir(uploadKey);
    fs.writeFileSync(getUploadMetaPath(uploadKey), JSON.stringify(meta, null, 2), 'utf8');
}

function removeUploadSession(uploadKey) {
    const sessionDir = getUploadSessionDir(uploadKey);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

function listUploadedChunkIndexes(uploadKey, totalChunks) {
    const uploaded = [];
    const meta = loadUploadMeta(uploadKey);
    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = getChunkPath(uploadKey, i);
        const stat = getFileStatSafe(chunkPath);
        if (stat && stat.isFile() && (!meta || stat.size === getExpectedChunkSize(meta, i))) {
            uploaded.push(i);
        }
    }
    return uploaded;
}

function removeAllUploadSessions() {
    if (!fs.existsSync(UPLOAD_SESSIONS_DIR)) {
        return;
    }

    for (const name of fs.readdirSync(UPLOAD_SESSIONS_DIR)) {
        const fullPath = path.join(UPLOAD_SESSIONS_DIR, name);
        try {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (e) {
            console.error('Failed to remove upload session:', fullPath, e);
        }
    }
}

function getFileStatSafe(filePath) {
    try {
        return fs.statSync(filePath);
    } catch (e) {
        return null;
    }
}

function getFileNameFromUrl(fileUrl) {
    const value = String(fileUrl || '').trim();
    const match = value.match(/\/api\/chat\/download\/([^?]+)/);
    if (!match) {
        return '';
    }

    try {
        return decodeURIComponent(match[1]);
    } catch (e) {
        return match[1];
    }
}

function getDirectorySize(targetPath) {
    const stat = getFileStatSafe(targetPath);
    if (!stat) {
        return 0;
    }

    if (stat.isFile()) {
        return stat.size;
    }

    if (!stat.isDirectory()) {
        return 0;
    }

    let total = 0;
    for (const name of fs.readdirSync(targetPath)) {
        total += getDirectorySize(path.join(targetPath, name));
    }
    return total;
}

function getUploadedFiles() {
    if (!fs.existsSync(UPLOADS_DIR)) {
        return [];
    }

    return fs.readdirSync(UPLOADS_DIR)
        .map(name => {
            const filePath = path.join(UPLOADS_DIR, name);
            const stat = getFileStatSafe(filePath);
            if (!stat || !stat.isFile()) {
                return null;
            }

            return {
                name,
                path: filePath,
                size: stat.size,
                mtimeMs: stat.mtimeMs
            };
        })
        .filter(Boolean);
}

function getUploadSessions() {
    if (!fs.existsSync(UPLOAD_SESSIONS_DIR)) {
        return [];
    }

    return fs.readdirSync(UPLOAD_SESSIONS_DIR)
        .map(name => {
            const sessionPath = path.join(UPLOAD_SESSIONS_DIR, name);
            const stat = getFileStatSafe(sessionPath);
            if (!stat || !stat.isDirectory()) {
                return null;
            }

            return {
                name,
                path: sessionPath,
                size: getDirectorySize(sessionPath),
                mtimeMs: stat.mtimeMs
            };
        })
        .filter(Boolean);
}

function removeHistoryEntriesByFileNames(fileNames) {
    if (!fileNames || fileNames.size === 0) {
        return 0;
    }

    const beforeCount = chatHistory.length;
    chatHistory = chatHistory.filter(message => {
        const storedName = getFileNameFromUrl(message.fileUrl);
        return !storedName || !fileNames.has(storedName);
    });

    const removedMessages = beforeCount - chatHistory.length;
    if (removedMessages > 0) {
        saveHistory();
    }
    return removedMessages;
}

function deleteUploadedFile(fileInfo) {
    try {
        if (fs.existsSync(fileInfo.path)) {
            fs.unlinkSync(fileInfo.path);
            return fileInfo.size || 0;
        }
    } catch (e) {
        console.error('Failed to remove uploaded file:', fileInfo.path, e);
    }
    return 0;
}

function deleteUploadSession(sessionInfo) {
    try {
        if (fs.existsSync(sessionInfo.path)) {
            fs.rmSync(sessionInfo.path, { recursive: true, force: true });
            return sessionInfo.size || 0;
        }
    } catch (e) {
        console.error('Failed to remove upload session:', sessionInfo.path, e);
    }
    return 0;
}

function getStorageStats() {
    const uploadedFiles = getUploadedFiles();
    const uploadSessions = getUploadSessions();
    const historyBytes = getFileStatSafe(HISTORY_FILE)?.size || 0;
    const configBytes = getFileStatSafe(CONFIG_FILE)?.size || 0;
    const devicesBytes = getFileStatSafe(DEVICES_FILE)?.size || 0;
    const uploadsBytes = uploadedFiles.reduce((sum, item) => sum + item.size, 0);
    const tempBytes = uploadSessions.reduce((sum, item) => sum + item.size, 0);
    const managedBytes = uploadsBytes + tempBytes;

    return {
        generatedAt: new Date().toISOString(),
        policy: storageConfig,
        usage: {
            uploadsBytes,
            uploadsCount: uploadedFiles.length,
            tempBytes,
            tempCount: uploadSessions.length,
            historyBytes,
            configBytes,
            devicesBytes,
            managedBytes,
            totalBytes: managedBytes + historyBytes + configBytes + devicesBytes
        }
    };
}

function cleanupStorage(options = {}) {
    const respectRetention = options.respectRetention !== false;
    const respectLimit = options.respectLimit !== false;
    const result = {
        deletedFiles: 0,
        deletedSessions: 0,
        removedMessages: 0,
        freedBytes: 0
    };
    const removedFileNames = new Set();
    const now = Date.now();

    if (respectRetention && storageConfig.retentionDays > 0) {
        const cutoff = now - storageConfig.retentionDays * 24 * 60 * 60 * 1000;
        const expiredSessions = getUploadSessions().filter(item => item.mtimeMs < cutoff);
        const expiredFiles = getUploadedFiles().filter(item => item.mtimeMs < cutoff);

        for (const sessionInfo of expiredSessions) {
            result.freedBytes += deleteUploadSession(sessionInfo);
            result.deletedSessions += 1;
        }

        for (const fileInfo of expiredFiles) {
            result.freedBytes += deleteUploadedFile(fileInfo);
            result.deletedFiles += 1;
            removedFileNames.add(fileInfo.name);
        }
    }

    if (respectLimit && storageConfig.maxStorageBytes > 0) {
        let sessions = getUploadSessions().sort((a, b) => a.mtimeMs - b.mtimeMs);
        let files = getUploadedFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
        let managedBytes =
            sessions.reduce((sum, item) => sum + item.size, 0) +
            files.reduce((sum, item) => sum + item.size, 0);

        for (const sessionInfo of sessions) {
            if (managedBytes <= storageConfig.maxStorageBytes) {
                break;
            }
            const removedBytes = deleteUploadSession(sessionInfo);
            if (removedBytes > 0) {
                managedBytes -= removedBytes;
                result.freedBytes += removedBytes;
                result.deletedSessions += 1;
            }
        }

        for (const fileInfo of files) {
            if (managedBytes <= storageConfig.maxStorageBytes) {
                break;
            }
            const removedBytes = deleteUploadedFile(fileInfo);
            if (removedBytes > 0) {
                managedBytes -= removedBytes;
                result.freedBytes += removedBytes;
                result.deletedFiles += 1;
                removedFileNames.add(fileInfo.name);
            }
        }
    }

    result.removedMessages = removeHistoryEntriesByFileNames(removedFileNames);
    return result;
}

function runAutoCleanup(trigger) {
    if (!storageConfig.autoCleanupEnabled) {
        return null;
    }

    const result = cleanupStorage();
    if (result.deletedFiles || result.deletedSessions || result.removedMessages) {
        broadcast({
            type: 'storage_updated',
            trigger: trigger || 'auto',
            result,
            stats: getStorageStats()
        });
    }
    return result;
}

function scheduleAutoCleanup() {
    const timer = setInterval(() => {
        try {
            runAutoCleanup('interval');
        } catch (e) {
            console.error('Auto cleanup failed.', e);
        }
    }, AUTO_CLEANUP_INTERVAL_MS);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

function broadcast(data) {
    const dataString = JSON.stringify(data);
    for (const client of sseClients) {
        try {
            client.res.write(`data: ${dataString}\n\n`);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

function broadcastConnections() {
    broadcast({
        type: 'connections',
        count: sseClients.size,
        onlineDevices: getOnlineDevices()
    });
}

// Config CORS
app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json());
app.use((req, res, next) => {
    rememberDevice(getRequestIp(req), req.headers['x-client-name']);
    next();
});

// Get local IPs
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                ips.push(alias.address);
            }
        }
    }
    return ips;
}

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        const safeName = crypto.randomBytes(16).toString('hex') + ext;
        cb(null, safeName);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE }
});
const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHUNK_SIZE + 1024 * 1024 }
});

// API Routes
app.get('/api/session-status', (req, res) => {
    const ip = getRequestIp(req);
    res.json({
        success: true,
        loggedIn: true,
        session: {
            username: '匿名用户',
            clientName: req.headers['x-client-name'] || '未知设备',
            ip,
            deviceAlias: getDeviceAlias(ip)
        },
        knownDevices: getKnownDevices()
    });
});

app.get('/api/chat/history', (req, res) => {
    res.json({ success: true, messages: chatHistory.map(formatMessage) });
});

app.get('/api/server-info', (req, res) => {
    const info = getAvailableUrls();
    res.json({
        success: true,
        host: HOST,
        port: PORT,
        currentIp: getRequestIp(req),
        urls: info.urls,
        lanIps: info.ips,
        preferredUrl: getPreferredConnectUrl(),
        knownDevices: getKnownDevices(),
        onlineDevices: getOnlineDevices()
    });
});

app.get('/api/storage/status', (req, res) => {
    res.json({
        success: true,
        stats: getStorageStats()
    });
});

app.post('/api/storage/config', (req, res) => {
    const nextStorageConfig = normalizeStorageConfig(req.body || {});
    storageConfig = nextStorageConfig;
    serverConfig.storage = nextStorageConfig;
    saveServerConfig(serverConfig);

    const cleanupResult = runAutoCleanup('config_update');
    res.json({
        success: true,
        storage: nextStorageConfig,
        cleanupResult,
        stats: getStorageStats()
    });
});

app.post('/api/storage/cleanup', (req, res) => {
    const mode = String((req.body && req.body.mode) || 'all');
    const respectRetention = mode === 'retention' || mode === 'all';
    const respectLimit = mode === 'size' || mode === 'all';
    const result = cleanupStorage({ respectRetention, respectLimit });
    const stats = getStorageStats();

    broadcast({
        type: 'storage_updated',
        trigger: `manual_${mode}`,
        result,
        stats
    });

    res.json({
        success: true,
        result,
        stats
    });
});

app.get('/api/devices', (req, res) => {
    res.json({
        success: true,
        currentIp: getRequestIp(req),
        devices: getKnownDevices()
    });
});

app.post('/api/devices/alias', (req, res) => {
    const ip = normalizeClientIp(req.body && req.body.ip);
    const alias = normalizeText(req.body && req.body.alias, 50);

    if (!ip) {
        return res.status(400).json({ success: false, error: 'Invalid IP' });
    }

    if (alias) {
        deviceData.aliases[ip] = alias.slice(0, 50);
    } else {
        delete deviceData.aliases[ip];
    }

    if (!deviceData.devices[ip]) {
        deviceData.devices[ip] = {
            clientNames: [],
            lastSeen: new Date().toISOString()
        };
    }

    saveDeviceData();
    broadcast({ type: 'device_alias_updated', devices: getKnownDevices() });
    res.json({ success: true, devices: getKnownDevices() });
});

app.post('/api/chat/send', (req, res) => {
    const { content, sender, clientName, fileUrl, fileName, fileDisplayName, fileType, isAnnouncement } = req.body;
    const ip = getRequestIp(req);
    const safeContent = normalizeText(content, MAX_MESSAGE_LENGTH);
    const safeSender = normalizeText(sender, MAX_CLIENT_NAME_LENGTH);
    const safeClientName = normalizeText(clientName, MAX_CLIENT_NAME_LENGTH);
    const safeFileUrl = String(fileUrl || '').trim();
    const safeFileName = normalizeText(fileName, MAX_FILE_NAME_LENGTH);
    const safeFileDisplayName = normalizeText(fileDisplayName, MAX_RELATIVE_PATH_LENGTH);
    const safeFileType = normalizeText(fileType, MAX_MIME_TYPE_LENGTH);
    
    if (!safeContent && !safeFileUrl) {
        return res.status(400).json({ success: false, error: 'Empty message' });
    }

    if (!isLocalDownloadUrl(safeFileUrl)) {
        return res.status(400).json({ success: false, error: 'Invalid file URL' });
    }

    rememberDevice(ip, safeClientName || safeSender);

    const msg = {
        id: 'msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        type: 'chat-message',
        sender: safeSender || '未知设备',
        clientName: safeClientName || '未知设备',
        content: safeContent,
        fileUrl: safeFileUrl,
        fileName: safeFileName,
        fileDisplayName: safeFileDisplayName || safeFileName,
        fileType: safeFileType,
        isAnnouncement: !!isAnnouncement,
        timestamp: Date.now(),
        ip
    };

    chatHistory.push(msg);
    if (chatHistory.length > 500) chatHistory.shift();
    saveHistory();

    broadcast(formatMessage(msg));
    res.json({ success: true, messageId: msg.id });
});

app.post('/api/chat/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const originalName = normalizeText(decodeOriginalName(req.file.originalname), MAX_FILE_NAME_LENGTH);

    const response = {
        success: true,
        fileUrl: `/api/chat/download/${req.file.filename}`,
        fileName: originalName || req.file.filename,
        fileType: normalizeText(req.file.mimetype, MAX_MIME_TYPE_LENGTH)
    };

    runAutoCleanup('upload');
    res.json(response);
});

app.post('/api/chat/upload/init', (req, res) => {
    const fileName = normalizeText(req.body && req.body.fileName, MAX_FILE_NAME_LENGTH);
    const fileType = normalizeText((req.body && req.body.fileType) || 'application/octet-stream', MAX_MIME_TYPE_LENGTH);
    const fileSize = Number(req.body && req.body.fileSize);
    const relativePath = normalizeText(req.body && req.body.relativePath, MAX_RELATIVE_PATH_LENGTH).replace(/^[\\/]+/, '');
    const fileKey = sanitizeUploadKey(req.body && req.body.fileKey);

    if (!fileName) {
        return res.status(400).json({ success: false, error: 'Invalid file name' });
    }

    if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
        return res.status(400).json({ success: false, error: 'Invalid file size' });
    }

    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
    const existingMeta = loadUploadMeta(fileKey);
    const uploadMeta = existingMeta && existingMeta.fileSize === fileSize && existingMeta.fileName === fileName
        ? existingMeta
        : {
            uploadKey: fileKey,
            fileName,
            fileType,
            fileSize,
            relativePath: relativePath || '',
            totalChunks,
            createdAt: new Date().toISOString()
        };

    uploadMeta.fileType = fileType;
    uploadMeta.relativePath = relativePath || uploadMeta.relativePath || '';
    uploadMeta.totalChunks = totalChunks;
    uploadMeta.updatedAt = new Date().toISOString();
    saveUploadMeta(fileKey, uploadMeta);

    res.json({
        success: true,
        uploadKey: fileKey,
        chunkSize: CHUNK_SIZE,
        totalChunks,
        uploadedChunks: listUploadedChunkIndexes(fileKey, totalChunks)
    });
});

app.post('/api/chat/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
    const uploadKey = sanitizeUploadKey(req.body && req.body.uploadKey);
    const chunkIndex = Number(req.body && req.body.chunkIndex);
    const totalChunks = Number(req.body && req.body.totalChunks);
    const meta = loadUploadMeta(uploadKey);

    if (!meta) {
        return res.status(404).json({ success: false, error: 'Upload session not found' });
    }

    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, error: 'No chunk uploaded' });
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
        return res.status(400).json({ success: false, error: 'Invalid chunk index' });
    }

    if (!Number.isInteger(totalChunks) || totalChunks !== meta.totalChunks) {
        return res.status(400).json({ success: false, error: 'Invalid total chunks' });
    }

    if (req.file.size !== getExpectedChunkSize(meta, chunkIndex)) {
        return res.status(400).json({ success: false, error: 'Invalid chunk size' });
    }

    ensureUploadSessionDir(uploadKey);
    fs.writeFileSync(getChunkPath(uploadKey, chunkIndex), req.file.buffer);
    meta.updatedAt = new Date().toISOString();
    saveUploadMeta(uploadKey, meta);

    res.json({ success: true, chunkIndex });
});

app.post('/api/chat/upload/complete', async (req, res) => {
    const uploadKey = sanitizeUploadKey(req.body && req.body.uploadKey);
    const meta = loadUploadMeta(uploadKey);

    if (!meta) {
        return res.status(404).json({ success: false, error: 'Upload session not found' });
    }

    const missingChunks = [];
    for (let i = 0; i < meta.totalChunks; i++) {
        const chunkPath = getChunkPath(uploadKey, i);
        const stat = getFileStatSafe(chunkPath);
        if (!stat || !stat.isFile() || stat.size !== getExpectedChunkSize(meta, i)) {
            missingChunks.push(i);
        }
    }

    if (missingChunks.length) {
        return res.status(400).json({
            success: false,
            error: 'Missing chunks',
            missingChunks
        });
    }

    const storedFileName = getSafeStoredFileName(meta.fileName);
    const finalPath = path.join(UPLOADS_DIR, storedFileName);

    try {
        const output = fs.createWriteStream(finalPath, { flags: 'wx' });
        for (let i = 0; i < meta.totalChunks; i++) {
            await pipeline(fs.createReadStream(getChunkPath(uploadKey, i)), output, { end: i === meta.totalChunks - 1 });
        }
    } catch (e) {
        console.error('Failed to merge upload chunks:', uploadKey, e);
        await fsp.rm(finalPath, { force: true }).catch(() => {});
        return res.status(500).json({ success: false, error: 'Failed to merge chunks' });
    }

    removeUploadSession(uploadKey);

    const response = {
        success: true,
        fileUrl: `/api/chat/download/${storedFileName}`,
        fileName: meta.fileName,
        fileType: meta.fileType,
        relativePath: meta.relativePath || ''
    };

    runAutoCleanup('upload_complete');
    res.json(response);
});

app.post('/api/chat/clear-files', (req, res) => {
    let deletedFiles = 0;
    const names = fs.readdirSync(UPLOADS_DIR);

    for (const name of names) {
        const filePath = path.join(UPLOADS_DIR, name);
        try {
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
                deletedFiles += 1;
            }
        } catch (e) {
            console.error('Failed to remove uploaded file:', filePath, e);
        }
    }

    const previousCount = chatHistory.length;
    chatHistory = chatHistory.filter(message => !message.fileUrl);
    saveHistory();

    const removedMessages = previousCount - chatHistory.length;
    removeAllUploadSessions();
    broadcast({ type: 'files_cleared', deletedFiles, removedMessages });
    res.json({ success: true, deletedFiles, removedMessages });
});

app.post('/api/chat/clear', (req, res) => {
    const removedMessages = chatHistory.length;
    chatHistory = [];
    saveHistory();

    const stats = getStorageStats();
    broadcast({ type: 'chat_clear', removedMessages });
    broadcast({
        type: 'storage_updated',
        trigger: 'chat_clear',
        result: {
            deletedFiles: 0,
            deletedSessions: 0,
            removedMessages,
            freedBytes: 0
        },
        stats
    });

    res.json({ success: true, removedMessages, stats });
});

app.get('/api/chat/download/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = resolveUploadedFilePath(fileName);
    
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    const downloadName = sanitizeDownloadName(req.query.name, fileName);
    res.download(filePath, downloadName, (err) => {
        if (err) {
            console.error("Download error:", err);
            if (!res.headersSent) {
                res.status(500).end();
            }
        }
    });
});

app.get('/api/events', (req, res) => {
    const client = {
        res,
        ip: getRequestIp(req),
        clientName: normalizeText(req.query.clientName, MAX_CLIENT_NAME_LENGTH) || '未知设备',
        connectedAt: new Date().toISOString()
    };

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.write('retry: 5000\n\n');
    
    sseClients.add(client);
    broadcastConnections();
    
    req.on('close', () => {
        sseClients.delete(client);
        broadcastConnections();
    });
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, '轻量局域网快传.html'));
});

let server = null;

async function startServer() {
    try {
        PORT = await resolveRuntimePort();
    } catch (err) {
        removeStatusFile();
        console.error('Server failed to resolve an available port.', err);
        process.exit(1);
    }

    server = app.listen(PORT, HOST, () => {
        console.log('\n=============================================');
        console.log('LAN Quick Transfer server is running');
        console.log('=============================================');
        const info = getAvailableUrls();
        const ips = info.ips;
        const uniqueUrls = info.urls;

        console.log(`\nBind host: ${HOST}`);
        console.log(`Port: ${PORT}`);
        console.log('\nDetected LAN IPv4 addresses:');
        if (ips.length === 0) {
            console.log(' - none');
        } else {
            ips.forEach(ip => console.log(` - ${ip}`));
        }
        console.log('\nOpen in browser:');
        uniqueUrls.forEach(url => console.log(` - ${url}`));

        writeStatusFile({
            pid: process.pid,
            host: HOST,
            port: PORT,
            urls: uniqueUrls,
            startedAt: new Date().toISOString()
        });

        runAutoCleanup('startup');
        scheduleAutoCleanup();
    });

    server.on('error', (err) => {
        removeStatusFile();
        if (err && err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use on ${HOST}.`);
        } else if (err && err.code === 'EADDRNOTAVAIL') {
            console.error(`Bind host ${HOST} is not available on this computer.`);
        } else {
            console.error('Server failed to start.', err);
        }
        process.exit(1);
    });
}

function shutdown() {
    removeStatusFile();
}

process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
});

process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
});

process.on('exit', shutdown);

startServer();
