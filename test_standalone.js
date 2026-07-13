const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function wait(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (fs.existsSync(filePath)) {
            return;
        }
        await wait(200);
    }
    throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForHttp(baseUrl, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const res = await fetch(`${baseUrl}/api/session-status`, {
                headers: { 'X-Client-Name': 'RegressionProbe' }
            });
            if (res.ok) {
                return;
            }
        } catch (e) {
        }
        await wait(300);
    }
    throw new Error(`Timed out waiting for server: ${baseUrl}`);
}

async function waitForCondition(predicate, timeoutMs = 5000, intervalMs = 50) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) {
            return;
        }
        await wait(intervalMs);
    }
    throw new Error('Timed out waiting for condition');
}

function createJsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}

function parseSseChunk(buffer, onEvent) {
    let content = buffer;
    while (true) {
        const index = content.indexOf('\n\n');
        if (index === -1) {
            return content;
        }

        const block = content.slice(0, index);
        content = content.slice(index + 2);

        const lines = block.split('\n');
        const dataLines = lines
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim());

        if (!dataLines.length) {
            continue;
        }

        try {
            onEvent(JSON.parse(dataLines.join('\n')));
        } catch (e) {
        }
    }
}

async function readSseUntil(reader, predicate, timeoutMs = 10000) {
    const startedAt = Date.now();
    let buffer = '';

    while (Date.now() - startedAt < timeoutMs) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += Buffer.from(value).toString('utf8');
        let matchedData = null;
        buffer = parseSseChunk(buffer, data => {
            if (!matchedData && predicate(data)) {
                matchedData = data;
            }
        });

        if (matchedData) {
            return matchedData;
        }
    }

    throw new Error('Timed out waiting for SSE event');
}

async function runUiSmokeTest(html) {
    const fetchCalls = [];
    const alerts = [];
    const toastMessages = [];
    function getToastText() {
        const container = document.getElementById('toastContainer');
        return container ? container.textContent : '';
    }
    function clickToastConfirm() {
        const btns = document.querySelectorAll('.toast-btn.primary');const btn = btns[btns.length - 1];
        if (btn) btn.click();
    }
    const clipboardWrites = [];
    const openedUrls = [];
    const uiHistoryMessages = [
        {
            id: 'msg_ui_1',
            sender: 'OfficePC',
            clientName: 'OfficePC',
            displaySender: '办公室电脑 [192.168.1.10]',
            content: '欢迎使用前端测试',
            timestamp: Date.now()
        }
    ];
    const devicesState = [
        {
            ip: '192.168.1.10',
            alias: '',
            clientNames: ['OfficePC'],
            lastSeen: '2026-05-18T16:35:00.000Z'
        }
    ];
    const serverInfoState = {
        success: true,
        preferredUrl: 'http://192.168.1.10:18082',
        urls: ['http://127.0.0.1:18082', 'http://192.168.1.10:18082'],
        onlineDevices: [
            {
                ip: '192.168.1.10',
                clientName: 'OfficePC',
                alias: '办公室电脑',
                connectedAt: '2026-05-18T16:40:00.000Z'
            }
        ],
        knownDevices: devicesState
    };
    const storageState = {
        usage: {
            managedBytes: 7340032,
            uploadsCount: 3,
            uploadsBytes: 5242880,
            tempCount: 1,
            tempBytes: 1048576,
            historyBytes: 2048,
            configBytes: 1024,
            devicesBytes: 1024,
            totalBytes: 7343104
        },
        policy: {
            retentionDays: 30,
            maxStorageBytes: 10737418240,
            autoCleanupEnabled: true
        },
        generatedAt: '2026-05-18T16:45:00.000Z'
    };

    async function mockFetch(url, options = {}) {
        const parsedUrl = new URL(url, 'http://127.0.0.1:18082');
        const pathname = parsedUrl.pathname;
        const method = String(options.method || 'GET').toUpperCase();
        fetchCalls.push(`${method} ${pathname}`);

        if (pathname === '/api/session-status') {
            return createJsonResponse({
                loggedIn: true,
                success: true,
                session: {
                    username: 'UI Tester',
                    clientName: 'UITEST'
                },
                knownDevices: devicesState
            });
        }

        if (pathname === '/api/chat/history') {
            return createJsonResponse({
                success: true,
                messages: uiHistoryMessages
            });
        }

        if (pathname === '/api/server-info') {
            return createJsonResponse(serverInfoState);
        }

        if (pathname === '/api/devices' && method === 'GET') {
            return createJsonResponse({
                success: true,
                devices: devicesState
            });
        }

        if (pathname === '/api/devices/alias' && method === 'POST') {
            const body = JSON.parse(options.body || '{}');
            devicesState[0] = {
                ...devicesState[0],
                alias: body.alias
            };
            serverInfoState.knownDevices = devicesState;
            return createJsonResponse({
                success: true,
                devices: devicesState
            });
        }

        if (pathname === '/api/storage/status') {
            return createJsonResponse({
                success: true,
                stats: storageState
            });
        }

        if (pathname === '/api/storage/config' && method === 'POST') {
            const body = JSON.parse(options.body || '{}');
            storageState.policy = {
                retentionDays: body.retentionDays,
                maxStorageBytes: body.maxStorageBytes,
                autoCleanupEnabled: body.autoCleanupEnabled
            };
            return createJsonResponse({
                success: true,
                stats: storageState,
                cleanupResult: {}
            });
        }

        if (pathname === '/api/storage/cleanup' && method === 'POST') {
            return createJsonResponse({
                success: true,
                stats: storageState,
                result: {
                    deletedFiles: 1,
                    deletedSessions: 1,
                    removedMessages: 1,
                    freedBytes: 1048576
                }
            });
        }

        if (pathname === '/api/chat/clear-files' && method === 'POST') {
            return createJsonResponse({
                success: true,
                deletedFiles: 2,
                removedMessages: 2
            });
        }

        if (pathname === '/api/chat/clear' && method === 'POST') {
            const removedMessages = uiHistoryMessages.length;
            uiHistoryMessages.splice(0, uiHistoryMessages.length);
            return createJsonResponse({
                success: true,
                removedMessages
            });
        }

        if (pathname === '/api/chat/send' && method === 'POST') {
            return createJsonResponse({
                success: true
            });
        }

        throw new Error(`Unhandled mock fetch: ${method} ${pathname}`);
    }

    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.onopen = null;
            this.onerror = null;
            this.onmessage = null;
            setTimeout(() => {
                if (this.onopen) {
                    this.onopen();
                }
                if (this.onmessage) {
                    this.onmessage({
                        data: JSON.stringify({
                            type: 'connections',
                            count: 2,
                            onlineDevices: serverInfoState.onlineDevices
                        })
                    });
                }
            }, 20);
        }

        close() {
            this.closed = true;
        }
    }

    const sanitizedHtml = html.replace('<script src="qr-generator.min.js"></script>', '');
    const dom = new JSDOM(sanitizedHtml, {
        url: 'http://127.0.0.1:18082/',
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.fetch = mockFetch;
            window.EventSource = FakeEventSource;
            window.alert = (message) => alerts.push(String(message));
            window.confirmToast = function(msg, cb) { if (cb) cb(); };
            window.confirm = () => true;
            window.open = (url) => openedUrls.push(String(url));
            window.localStorage.setItem('lan_server_url', 'http://127.0.0.1:18082');
            window.localStorage.setItem('lan_quick_transfer_client', 'UITEST');
            window.sessionStorage.setItem('displayName', 'UI Tester');
            window.navigator.clipboard = {
                writeText: async (value) => {
                    clipboardWrites.push(String(value));
                }
            };
            window.qrcode = function qrcode() {
                return {
                    addData() {},
                    make() {},
                    createSvgTag() {
                        return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
                    }
                };
            };
            window.document.execCommand = () => true;
        }
    });

    const { window } = dom;
    const document = window.document;

    try {
        await waitForCondition(() => document.getElementById('onlineCount').textContent.includes('2 个设备在线'), 4000);
        assert(document.getElementById('messages').textContent.includes('欢迎使用前端测试'), 'History did not render');

        document.getElementById('btnOpenConnect').click();
        await waitForCondition(() => document.getElementById('connectModal').classList.contains('active'));
        await waitForCondition(() => document.getElementById('connectUrlList').textContent.includes('192.168.1.10:18082'));
        assert(document.getElementById('connectQrTip').textContent.includes('192.168.1.10:18082'), 'Connect QR tip did not render');
        window.copyText('http://192.168.1.10:18082');
        await waitForCondition(() => clipboardWrites.includes('http://192.168.1.10:18082'));

        document.getElementById('btnOpenDevices').click();
        await waitForCondition(() => document.getElementById('deviceModal').classList.contains('active'));
        await waitForCondition(() => document.querySelector('.device-alias-input'));
        const aliasInput = document.querySelector('.device-alias-input');
        aliasInput.value = '新办公室电脑';
        window.saveDeviceAlias('192.168.1.10');
        await waitForCondition(() => document.querySelector('.device-alias-input').value === '新办公室电脑');

        document.getElementById('btnOpenStorage').click();
        await waitForCondition(() => document.getElementById('storageModal').classList.contains('active'));
        await waitForCondition(() => document.getElementById('storageSummary').textContent.includes('当前占用'));
        document.getElementById('retentionDaysInput').value = '15';
        document.getElementById('maxStorageGbInput').value = '5';
        document.getElementById('autoCleanupEnabledInput').checked = false;
        document.getElementById('btnSaveStorage').click();
        await waitForCondition(() => getToastText().includes('存储策略已保存'));
        document.getElementById('btnCleanupAll').click();
        await waitForCondition(() => document.querySelector('.toast-btn.primary'));
        clickToastConfirm();
        await waitForCondition(() => getToastText().includes('已清理 1 个文件'));

        document.getElementById('btnClearFiles').click();
        await waitForCondition(() => document.querySelector('.toast-btn.primary'));
        clickToastConfirm();
        await waitForCondition(() => getToastText().includes('已清理 2 个文件'));

        document.getElementById('btnClearHistory').click();
        await waitForCondition(() => document.querySelector('.toast-btn.primary'));
        clickToastConfirm();
        await waitForCondition(() => getToastText().includes('已清空 1 条聊天记录'));
        await waitForCondition(() => document.getElementById('messages').textContent.includes('记录已被清空'));

        assert(fetchCalls.includes('GET /api/server-info'), 'Connect API was not called');
        assert(fetchCalls.includes('GET /api/devices'), 'Devices API was not called');
        assert(fetchCalls.includes('POST /api/devices/alias'), 'Device alias API was not called');
        assert(fetchCalls.includes('GET /api/storage/status'), 'Storage status API was not called');
        assert(fetchCalls.includes('POST /api/storage/config'), 'Storage config API was not called');
        assert(fetchCalls.includes('POST /api/storage/cleanup'), 'Storage cleanup API was not called');
        assert(fetchCalls.includes('POST /api/chat/clear'), 'Clear history API was not called');
        assert(fetchCalls.includes('POST /api/chat/clear-files'), 'Clear files API was not called');

        return {
            connectModal: 'ok',
            deviceModal: 'ok',
            storageModal: 'ok',
            clearHistoryFlow: 'ok',
            clearFilesFlow: 'ok'
        };
    } finally {
        window.close();
    }
}

async function main() {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lan-qt-regression-'));
    const dataDir = path.join(tempRoot, 'data');
    const uploadsDir = path.join(tempRoot, 'uploads');
    const statusPath = path.join(dataDir, 'server-status.json');
    const configPath = path.join(dataDir, 'server-config.json');
    const htmlPath = path.join(__dirname, '轻量局域网快传.html');
    const html = await fsp.readFile(htmlPath, 'utf8');
    const testMarker = `REGRESSION_${Date.now()}`;
    let child = null;

    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(uploadsDir, { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
        host: '127.0.0.1',
        port: 18080,
        storage: {
            retentionDays: 30,
            maxStorageBytes: 1024 * 1024 * 1024,
            autoCleanupEnabled: true
        }
    }, null, 2));

    try {
        const uiReport = await runUiSmokeTest(html);
        child = spawn(process.execPath, ['server.js'], {
            cwd: __dirname,
            env: {
                ...process.env,
                LAN_QT_DATA_DIR: dataDir,
                LAN_QT_UPLOADS_DIR: uploadsDir
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrOutput = '';
        child.stderr.on('data', chunk => {
            stderrOutput += chunk.toString('utf8');
        });

        await waitForFile(statusPath);
        const status = JSON.parse(await fsp.readFile(statusPath, 'utf8'));
        const baseUrl = status.urls[0];
        assert(status.port !== 18080 && status.port !== 18081, 'Reserved port was not avoided');
        await waitForHttp(baseUrl);

        const report = {};

        assert(html.includes('id="btnOpenConnect"'), 'Missing connect button');
        assert(html.includes('id="btnOpenStorage"'), 'Missing storage button');
        assert(html.includes('id="btnClearHistory"'), 'Missing clear history button');
        assert(html.includes('id="btnClearFiles"'), 'Missing clear files button');
        report.htmlStructure = 'ok';
        report.frontendUi = uiReport;

        const session = await fetch(`${baseUrl}/api/session-status`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(session.success === true, 'Session status failed');
        report.sessionStatus = 'ok';

        const serverInfo = await fetch(`${baseUrl}/api/server-info`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(serverInfo.success === true && Array.isArray(serverInfo.urls) && serverInfo.urls.length > 0, 'Server info failed');
        report.serverInfo = 'ok';

        const sseController = new AbortController();
        const sseResponse = await fetch(`${baseUrl}/api/events?clientName=RegressionSSE`, {
            signal: sseController.signal
        });
        assert(sseResponse.ok && sseResponse.body, 'SSE connection failed');
        const reader = sseResponse.body.getReader();
        await readSseUntil(reader, data => data.type === 'connections');
        report.sseConnect = 'ok';

        const sendPayload = {
            content: `[${testMarker}] hello`,
            sender: 'RegressionClient',
            clientName: 'RegressionClient',
            isAnnouncement: false
        };
        const sendResult = await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify(sendPayload)
        }).then(res => res.json());
        assert(sendResult.success === true, 'Chat send failed');

        await readSseUntil(reader, data => data.type === 'chat-message' && data.content === `[${testMarker}] hello`);
        const history = await fetch(`${baseUrl}/api/chat/history`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(history.success === true && history.messages.some(message => message.content === `[${testMarker}] hello`), 'Chat history validation failed');
        report.chatAndSse = 'ok';

        const aliasPayload = { ip: '127.0.0.1', alias: 'Regression Alias' };
        const aliasResult = await fetch(`${baseUrl}/api/devices/alias`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify(aliasPayload)
        }).then(res => res.json());
        assert(aliasResult.success === true, 'Device alias update failed');
        report.deviceAlias = 'ok';

        const uploadContent = `upload-content-${testMarker}`;
        const uploadForm = new FormData();
        uploadForm.append('file', new Blob([uploadContent], { type: 'text/plain' }), 'upload.txt');
        const uploadResult = await fetch(`${baseUrl}/api/chat/upload`, {
            method: 'POST',
            headers: { 'X-Client-Name': 'RegressionClient' },
            body: uploadForm
        }).then(res => res.json());
        assert(uploadResult.success === true, 'Standard upload failed');

        const uploadDownload = await fetch(`${baseUrl}${uploadResult.fileUrl}?name=${encodeURIComponent(uploadResult.fileName)}`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.text());
        assert(uploadDownload.includes(testMarker), 'Standard download failed');
        report.standardUploadDownload = 'ok';

        const chunkContent = `chunk-content-${testMarker}`.repeat(200);
        const initResult = await fetch(`${baseUrl}/api/chat/upload/init`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify({
                fileName: 'chunk.txt',
                fileType: 'text/plain',
                fileSize: Buffer.byteLength(chunkContent),
                relativePath: '',
                fileKey: `regression_${testMarker}`
            })
        }).then(res => res.json());
        assert(initResult.success === true, 'Chunk init failed');

        const chunkForm = new FormData();
        chunkForm.append('uploadKey', `regression_${testMarker}`);
        chunkForm.append('chunkIndex', '0');
        chunkForm.append('totalChunks', String(initResult.totalChunks));
        chunkForm.append('chunk', new Blob([chunkContent], { type: 'text/plain' }), 'chunk.txt');
        const chunkUpload = await fetch(`${baseUrl}/api/chat/upload/chunk`, {
            method: 'POST',
            headers: { 'X-Client-Name': 'RegressionClient' },
            body: chunkForm
        }).then(res => res.json());
        assert(chunkUpload.success === true, 'Chunk upload failed');

        const chunkComplete = await fetch(`${baseUrl}/api/chat/upload/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify({ uploadKey: `regression_${testMarker}` })
        }).then(res => res.json());
        assert(chunkComplete.success === true, 'Chunk complete failed');
        const chunkDownload = await fetch(`${baseUrl}${chunkComplete.fileUrl}?name=${encodeURIComponent(chunkComplete.fileName)}`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.text());
        assert(chunkDownload.includes(testMarker), 'Chunk download failed');
        report.chunkUpload = 'ok';

        const storageStatus = await fetch(`${baseUrl}/api/storage/status`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(storageStatus.success === true, 'Storage status failed');

        const storageConfig = await fetch(`${baseUrl}/api/storage/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify({
                retentionDays: 15,
                maxStorageBytes: 512 * 1024 * 1024,
                autoCleanupEnabled: true
            })
        }).then(res => res.json());
        assert(storageConfig.success === true, 'Storage config failed');

        const storageCleanup = await fetch(`${baseUrl}/api/storage/cleanup`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Name': 'RegressionClient'
            },
            body: JSON.stringify({ mode: 'all' })
        }).then(res => res.json());
        assert(storageCleanup.success === true, 'Storage cleanup failed');
        report.storageManagement = 'ok';

        const clearFiles = await fetch(`${baseUrl}/api/chat/clear-files`, {
            method: 'POST',
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(clearFiles.success === true, 'Clear files failed');
        report.clearFiles = 'ok';

        const clearHistory = await fetch(`${baseUrl}/api/chat/clear`, {
            method: 'POST',
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(clearHistory.success === true, 'Clear history failed');
        await readSseUntil(reader, data => data.type === 'chat_clear');
        const clearedHistory = await fetch(`${baseUrl}/api/chat/history`, {
            headers: { 'X-Client-Name': 'RegressionClient' }
        }).then(res => res.json());
        assert(clearedHistory.success === true && clearedHistory.messages.length === 0, 'Chat history was not cleared');
        report.clearHistory = 'ok';

        sseController.abort();
        console.log(JSON.stringify({
            success: true,
            baseUrl,
            port: status.port,
            report
        }, null, 2));
    } finally {
        if (child && !child.killed) {
            child.kill('SIGTERM');
        }
        await fsp.rm(tempRoot, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
