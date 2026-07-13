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
const DOWNLOAD_STREAM_HIGH_WATER_MARK = 256 * 1024; // 256KB read buffer for LAN file serving
const DOWNLOAD_SOCKET_TIMEOUT_MS = 300 * 1000; // 5 minute socket timeout for large files
const DEFAULT_RETENTION_DAYS = 0; // 0 means no automatic deletion by default
const DEFAULT_MAX_STORAGE_BYTES = 0; // 0 means unlimited by default
const AUTO_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const DEVICE_LAST_SEEN_SAVE_INTERVAL_MS = 30 * 1000;
const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 20000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 120;
const MAX_RELATIVE_PATH_LENGTH = 1000;
const QR_VERSION = 4;
const QR_SIZE = 4 * QR_VERSION + 17;
const QR_DATA_CODEWORDS = 64;
const QR_EC_CODEWORDS_PER_BLOCK = 18;
const QR_BLOCK_COUNT = 2;
const QR_MAX_BYTES = QR_DATA_CODEWORDS - 2;
const FILE_EXPIRATION_PRESETS = new Set(['1h', '1d', '7d', 'never']);
const MAX_BATCH_DOWNLOAD_FILES = 200;
const ZIP_DOS_EPOCH = new Date('1980-01-01T00:00:00Z').getTime();

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

function normalizeExpirationPreset(value) {
    const preset = String(value || '').trim().toLowerCase();
    return FILE_EXPIRATION_PRESETS.has(preset) ? preset : 'never';
}

function getExpirationTimestamp(preset, baseTime = Date.now()) {
    const normalized = normalizeExpirationPreset(preset);
    if (normalized === '1h') {
        return baseTime + 60 * 60 * 1000;
    }
    if (normalized === '1d') {
        return baseTime + 24 * 60 * 60 * 1000;
    }
    if (normalized === '7d') {
        return baseTime + 7 * 24 * 60 * 60 * 1000;
    }
    return null;
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

function cleanupExpiredFileMessages(now = Date.now()) {
    const expiredFileNames = new Set();
    for (const message of chatHistory) {
        const expiresAt = Number(message && message.expiresAt);
        if (!message.fileUrl || !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > now) {
            continue;
        }
        const storedName = getFileNameFromUrl(message.fileUrl);
        if (storedName) {
            expiredFileNames.add(storedName);
        }
    }

    let deletedFiles = 0;
    let freedBytes = 0;
    for (const fileName of expiredFileNames) {
        const filePath = resolveUploadedFilePath(fileName);
        const stat = filePath ? getFileStatSafe(filePath) : null;
        if (stat && stat.isFile()) {
            freedBytes += deleteUploadedFile({ path: filePath, size: stat.size });
            deletedFiles += 1;
        }
    }

    const removedMessages = removeHistoryEntriesByFileNames(expiredFileNames);
    return { deletedFiles, removedMessages, freedBytes };
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
    const expiredResult = cleanupExpiredFileMessages(now);
    result.deletedFiles += expiredResult.deletedFiles;
    result.removedMessages += expiredResult.removedMessages;
    result.freedBytes += expiredResult.freedBytes;
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

function getCrc32Table() {
    if (getCrc32Table.table) {
        return getCrc32Table.table;
    }
    const table = new Array(256);
    for (let i = 0; i < 256; i++) {
        let value = i;
        for (let j = 0; j < 8; j++) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[i] = value >>> 0;
    }
    getCrc32Table.table = table;
    return table;
}

function getCrc32(buffer) {
    const table = getCrc32Table();
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function getZipDosTime(value) {
    const date = new Date(Math.max(Number(value) || Date.now(), ZIP_DOS_EPOCH));
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

function writeUInt16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return buffer;
}

function writeUInt32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0);
    return buffer;
}

function buildZipBuffer(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file, index) => {
        const data = fs.readFileSync(file.path);
        const safeName = sanitizeDownloadName(file.downloadName, `file-${index + 1}`);
        const entryName = Buffer.from(safeName, 'utf8');
        const crc = getCrc32(data);
        const size = data.length;
        const dos = getZipDosTime(file.mtimeMs);
        const localHeader = Buffer.concat([
            writeUInt32(0x04034b50),
            writeUInt16(20),
            writeUInt16(0x0800),
            writeUInt16(0),
            writeUInt16(dos.time),
            writeUInt16(dos.day),
            writeUInt32(crc),
            writeUInt32(size),
            writeUInt32(size),
            writeUInt16(entryName.length),
            writeUInt16(0),
            entryName
        ]);

        localParts.push(localHeader, data);

        centralParts.push(Buffer.concat([
            writeUInt32(0x02014b50),
            writeUInt16(20),
            writeUInt16(20),
            writeUInt16(0x0800),
            writeUInt16(0),
            writeUInt16(dos.time),
            writeUInt16(dos.day),
            writeUInt32(crc),
            writeUInt32(size),
            writeUInt32(size),
            writeUInt16(entryName.length),
            writeUInt16(0),
            writeUInt16(0),
            writeUInt16(0),
            writeUInt16(0),
            writeUInt32(0),
            writeUInt32(offset),
            entryName
        ]));

        offset += localHeader.length + data.length;
    });

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.concat([
        writeUInt32(0x06054b50),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(files.length),
        writeUInt16(files.length),
        writeUInt32(centralDirectory.length),
        writeUInt32(offset),
        writeUInt16(0)
    ]);

    return Buffer.concat([...localParts, centralDirectory, endRecord]);
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

function gfMultiply(a, b) {
    let result = 0;
    while (b > 0) {
        if (b & 1) result ^= a;
        a <<= 1;
        if (a & 0x100) a ^= 0x11d;
        b >>= 1;
    }
    return result;
}

function rsGenerator(degree) {
    let poly = [1];
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j += 1) {
            next[j] ^= gfMultiply(poly[j], root);
            next[j + 1] ^= poly[j];
        }
        poly = next;
        root = gfMultiply(root, 2);
    }
    return poly;
}

function rsRemainder(data, degree) {
    const generator = rsGenerator(degree);
    const result = new Array(degree).fill(0);
    for (const value of data) {
        const factor = value ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i += 1) {
            result[i] ^= gfMultiply(generator[i], factor);
        }
    }
    return result;
}

function pushBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
        bits.push((value >>> i) & 1);
    }
}

function buildQrDataCodewords(text) {
    const bytes = Array.from(Buffer.from(text, 'utf8'));
    if (bytes.length > QR_MAX_BYTES) {
        throw new Error(`QR text is too long. Maximum UTF-8 bytes: ${QR_MAX_BYTES}`);
    }

    const bits = [];
    pushBits(bits, 0b0100, 4);
    pushBits(bits, bytes.length, 8);
    for (const byte of bytes) pushBits(bits, byte, 8);
    const capacityBits = QR_DATA_CODEWORDS * 8;
    const terminatorBits = Math.min(4, capacityBits - bits.length);
    pushBits(bits, 0, terminatorBits);
    while (bits.length % 8) bits.push(0);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
        data.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
    }
    for (let pad = 0xec; data.length < QR_DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) {
        data.push(pad);
    }
    return data;
}

function buildQrCodewords(text) {
    const data = buildQrDataCodewords(text);
    const dataBlocks = [];
    const ecBlocks = [];
    const blockSize = QR_DATA_CODEWORDS / QR_BLOCK_COUNT;
    for (let i = 0; i < QR_BLOCK_COUNT; i += 1) {
        const block = data.slice(i * blockSize, (i + 1) * blockSize);
        dataBlocks.push(block);
        ecBlocks.push(rsRemainder(block, QR_EC_CODEWORDS_PER_BLOCK));
    }

    const result = [];
    for (let i = 0; i < blockSize; i += 1) {
        for (const block of dataBlocks) result.push(block[i]);
    }
    for (let i = 0; i < QR_EC_CODEWORDS_PER_BLOCK; i += 1) {
        for (const block of ecBlocks) result.push(block[i]);
    }
    return result;
}

function createQrMatrix() {
    return {
        modules: Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false)),
        reserved: Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false))
    };
}

function setQrModule(qr, row, col, value, reserve = true) {
    if (row < 0 || col < 0 || row >= QR_SIZE || col >= QR_SIZE) return;
    qr.modules[row][col] = !!value;
    if (reserve) qr.reserved[row][col] = true;
}

function placeFinder(qr, row, col) {
    for (let r = -1; r <= 7; r += 1) {
        for (let c = -1; c <= 7; c += 1) {
            const rr = row + r;
            const cc = col + c;
            const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
                (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
            setQrModule(qr, rr, cc, dark);
        }
    }
}

function placeAlignment(qr, row, col) {
    for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
            const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            setQrModule(qr, row + r, col + c, dark);
        }
    }
}

function placeQrPatterns(qr) {
    placeFinder(qr, 0, 0);
    placeFinder(qr, 0, QR_SIZE - 7);
    placeFinder(qr, QR_SIZE - 7, 0);
    for (let i = 8; i < QR_SIZE - 8; i += 1) {
        setQrModule(qr, 6, i, i % 2 === 0);
        setQrModule(qr, i, 6, i % 2 === 0);
    }
    placeAlignment(qr, 26, 26);
    setQrModule(qr, QR_SIZE - 8, 8, true);
    for (let i = 0; i < 9; i += 1) {
        setQrModule(qr, 8, i, false);
        setQrModule(qr, i, 8, false);
        setQrModule(qr, 8, QR_SIZE - 1 - i, false);
        setQrModule(qr, QR_SIZE - 1 - i, 8, false);
    }
}

function getFormatBits() {
    let data = 0;
    let value = data << 10;
    const generator = 0x537;
    for (let i = 14; i >= 10; i -= 1) {
        if ((value >>> i) & 1) value ^= generator << (i - 10);
    }
    return ((data << 10) | value) ^ 0x5412;
}

function placeFormatBits(qr) {
    const bits = getFormatBits();
    const first = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    const second = [[QR_SIZE-1,8],[QR_SIZE-2,8],[QR_SIZE-3,8],[QR_SIZE-4,8],[QR_SIZE-5,8],[QR_SIZE-6,8],[QR_SIZE-7,8],[8,QR_SIZE-8],[8,QR_SIZE-7],[8,QR_SIZE-6],[8,QR_SIZE-5],[8,QR_SIZE-4],[8,QR_SIZE-3],[8,QR_SIZE-2],[8,QR_SIZE-1]];
    for (let i = 0; i < 15; i += 1) {
        const bit = ((bits >>> i) & 1) === 1;
        setQrModule(qr, first[i][0], first[i][1], bit);
        setQrModule(qr, second[i][0], second[i][1], bit);
    }
}

function placeQrData(qr, codewords) {
    const bits = [];
    for (const codeword of codewords) pushBits(bits, codeword, 8);
    let bitIndex = 0;
    let upward = true;
    for (let col = QR_SIZE - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (let i = 0; i < QR_SIZE; i += 1) {
            const row = upward ? QR_SIZE - 1 - i : i;
            for (let offset = 0; offset < 2; offset += 1) {
                const currentCol = col - offset;
                if (qr.reserved[row][currentCol]) continue;
                const rawBit = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
                const masked = rawBit !== ((row + currentCol) % 2 === 0);
                setQrModule(qr, row, currentCol, masked, false);
                bitIndex += 1;
            }
        }
        upward = !upward;
    }
}

function createQrSvg(text) {
    const qr = createQrMatrix();
    placeQrPatterns(qr);
    placeQrData(qr, buildQrCodewords(text));
    placeFormatBits(qr);
    const margin = 4;
    const size = QR_SIZE + margin * 2;
    const rects = [];
    for (let row = 0; row < QR_SIZE; row += 1) {
        for (let col = 0; col < QR_SIZE; col += 1) {
            if (qr.modules[row][col]) {
                rects.push(`<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`);
            }
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

// Config CORS
app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Global socket optimization for LAN file transfers
app.use((req, res, next) => {
    const socket = req.socket;
    if (socket) {
        socket.setNoDelay(true);
        socket.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS);
    }
    next();
});

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
const CHUNK_TMP_DIR = path.join(UPLOAD_SESSIONS_DIR, '_tmp');
if (!fs.existsSync(CHUNK_TMP_DIR)) fs.mkdirSync(CHUNK_TMP_DIR, { recursive: true });
const chunkUpload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) { cb(null, CHUNK_TMP_DIR); },
        filename: function (req, file, cb) { cb(null, crypto.randomBytes(16).toString('hex') + '.chunktmp'); }
    }),
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
    runAutoCleanup('history');
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

app.get('/api/qr.svg', (req, res) => {
    const text = String(req.query.text || '').trim();
    if (!text) {
        return res.status(400).type('text/plain').send('Missing text');
    }

    try {
        res.type('image/svg+xml').send(createQrSvg(text));
    } catch (e) {
        res.status(400).type('text/plain').send(e.message || 'Failed to generate QR code');
    }
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

app.post('/api/chat/batch-download', (req, res) => {
    runAutoCleanup('batch_download');
    const items = Array.isArray(req.body && req.body.files) ? req.body.files.slice(0, MAX_BATCH_DOWNLOAD_FILES) : [];
    const selected = [];
    const seen = new Set();

    for (const item of items) {
        const fileUrl = typeof item === 'string' ? item : item && item.fileUrl;
        const storedName = getFileNameFromUrl(fileUrl);
        if (!storedName || seen.has(storedName)) {
            continue;
        }
        const filePath = resolveUploadedFilePath(storedName);
        const stat = filePath ? getFileStatSafe(filePath) : null;
        if (!stat || !stat.isFile()) {
            continue;
        }
        seen.add(storedName);
        selected.push({
            path: filePath,
            mtimeMs: stat.mtimeMs,
            downloadName: typeof item === 'object' && item ? item.fileName || item.fileDisplayName || storedName : storedName
        });
    }

    if (!selected.length) {
        return res.status(400).json({ success: false, error: 'No downloadable files selected' });
    }

    try {
        const zipBuffer = buildZipBuffer(selected);
        const zipName = `lan-quick-transfer-${new Date().toISOString().slice(0, 10)}.zip`;
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${zipName}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);
    } catch (e) {
        console.error('Failed to create batch download zip.', e);
        res.status(500).json({ success: false, error: 'Failed to create ZIP' });
    }
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
    const { content, sender, clientName, fileUrl, fileName, fileDisplayName, fileType, isAnnouncement, expirationPreset, expiresAt } = req.body;
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

    if (safeFileUrl) {
        const normalizedExpiration = normalizeExpirationPreset(expirationPreset);
        const requestedExpiresAt = Number(expiresAt);
        msg.expirationPreset = normalizedExpiration;
        msg.expiresAt = Number.isFinite(requestedExpiresAt) && requestedExpiresAt > Date.now()
            ? requestedExpiresAt
            : getExpirationTimestamp(normalizedExpiration, msg.timestamp);
    }

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
    const tmpPath = req.file && req.file.path ? req.file.path : null;

    function cleanupTmp() {
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ } }
    }

    if (!meta) {
        cleanupTmp();
        return res.status(404).json({ success: false, error: 'Upload session not found' });
    }

    if (!req.file || !tmpPath) {
        cleanupTmp();
        return res.status(400).json({ success: false, error: 'No chunk uploaded' });
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
        cleanupTmp();
        return res.status(400).json({ success: false, error: 'Invalid chunk index' });
    }

    if (!Number.isInteger(totalChunks) || totalChunks !== meta.totalChunks) {
        cleanupTmp();
        return res.status(400).json({ success: false, error: 'Invalid total chunks' });
    }

    if (req.file.size !== getExpectedChunkSize(meta, chunkIndex)) {
        cleanupTmp();
        return res.status(400).json({ success: false, error: 'Invalid chunk size' });
    }

    ensureUploadSessionDir(uploadKey);
    const chunkDest = getChunkPath(uploadKey, chunkIndex);
    try {
        try { fs.unlinkSync(chunkDest); } catch (e) { /* ignore if not exists */ }
        fs.renameSync(tmpPath, chunkDest);
    } catch (e) {
        try {
            const data = fs.readFileSync(tmpPath);
            fs.writeFileSync(chunkDest, data);
            fs.unlinkSync(tmpPath);
        } catch (e2) {
            cleanupTmp();
            console.error('Failed to persist chunk:', uploadKey, chunkIndex, e2);
            return res.status(500).json({ success: false, error: 'Failed to store chunk' });
        }
    }
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
    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const encodedName = encodeURIComponent(downloadName).replace(/['()]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    const asciiName = downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const contentDisposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
    const baseHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition
    };

    // LAN speed optimizations: disable Nagle algorithm, set socket timeout
    const socket = req.socket;
    if (socket) {
        socket.setNoDelay(true);
        socket.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS);
        // Set larger send buffer for LAN throughput (1MB)
        try { socket.setSendBufferSize(1024 * 1024); } catch (e) { /* ignore if not supported */ }
    }

    const range = req.headers.range;

    if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
            return res.status(416).set({
                ...baseHeaders,
                'Content-Range': `bytes */${totalSize}`
            }).end();
        }

        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : totalSize - 1;
        if (!match[1] && match[2]) {
            const suffixLength = Number(match[2]);
            start = Math.max(0, totalSize - suffixLength);
            end = totalSize - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalSize) {
            return res.status(416).set({
                ...baseHeaders,
                'Content-Range': `bytes */${totalSize}`
            }).end();
        }
        end = Math.min(end, totalSize - 1);

        res.writeHead(206, {
            ...baseHeaders,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`
        });
        const readStream = fs.createReadStream(filePath, {
            start,
            end,
            highWaterMark: DOWNLOAD_STREAM_HIGH_WATER_MARK
        });
        readStream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
        req.on('close', () => readStream.destroy());
        readStream.pipe(res);
        return;
    }

    res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': totalSize
    });
    const readStream = fs.createReadStream(filePath, {
        highWaterMark: DOWNLOAD_STREAM_HIGH_WATER_MARK
    });
    readStream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    req.on('close', () => readStream.destroy());
    readStream.pipe(res);
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


// 404 handler for unmatched API routes
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Global error handler - catches sync/async errors from all routes
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, error: 'Request body too large' });
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'File size exceeds limit' });
    }
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
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

let isShuttingDown = false;

function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`
${signal || 'Shutting down'}: closing connections...`);
    removeStatusFile();

    // Close all SSE clients immediately
    for (const client of sseClients) {
        try { client.res.end(); } catch (e) { /* ignore */ }
    }
    sseClients.clear();

    if (server && server.listening) {
        server.close(() => {
            process.exit(0);
        });
        // Force exit after 5s if connections hang
        setTimeout(() => process.exit(0), 5000).unref();
    } else {
        process.exit(0);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Prevent crashes from killing the server on unexpected errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

startServer();
