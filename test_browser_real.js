const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

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
                headers: { 'X-Client-Name': 'BrowserRegressionProbe' }
            });
            if (res.ok) {
                return;
            }
        } catch (err) {
        }
        await wait(300);
    }
    throw new Error(`Timed out waiting for server: ${baseUrl}`);
}

function getBrowserCandidates() {
    const candidates = [];
    const add = (value) => {
        if (!value || typeof value !== 'string') {
            return;
        }
        const resolved = path.normalize(value);
        if (!candidates.includes(resolved)) {
            candidates.push(resolved);
        }
    };

    add(process.env.LAN_QT_BROWSER_EXE);

    if (process.platform === 'win32') {
        add(path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        add(path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        add(path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
        add(path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
        add(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
        add(path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'));
    }

    return candidates.filter(candidate => candidate && fs.existsSync(candidate));
}

function getBrowserLaunchOptions() {
    const matches = getBrowserCandidates();
    if (!matches.length) {
        throw new Error(
            'No supported browser executable was found. Install Microsoft Edge or Google Chrome, ' +
            'or set LAN_QT_BROWSER_EXE to a Chromium-based browser executable.'
        );
    }

    return {
        executablePath: matches[0],
        headless: true,
        args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-background-timer-throttling'
        ]
    };
}

async function waitForPageText(page, selector, expectedText, timeoutMs = 10000) {
    await page.waitForFunction(
        ({ pageSelector, text }) => {
            const node = document.querySelector(pageSelector);
            return node && node.textContent && node.textContent.includes(text);
        },
        { pageSelector: selector, text: expectedText },
        { timeout: timeoutMs }
    );
}

async function waitForDialogMessage(dialogs, matcher, timeoutMs = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (dialogs.some(dialog => matcher(dialog.message))) {
            return;
        }
        await wait(100);
    }
    throw new Error('Timed out waiting for browser dialog');
}

async function createClientContext(browser, clientName, displayName) {
    const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 960 }
    });
    const dialogs = [];

    await context.addInitScript(
        ({ initClientName, initDisplayName }) => {
            localStorage.setItem('lan_quick_transfer_client', initClientName);
            sessionStorage.setItem('displayName', initDisplayName);
        },
        { initClientName: clientName, initDisplayName: displayName }
    );

    const page = await context.newPage();
    page.on('dialog', async dialog => {
        dialogs.push({
            type: dialog.type(),
            message: dialog.message()
        });
        await dialog.accept();
    });

    return { context, page, dialogs };
}

async function main() {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lan-qt-browser-regression-'));
    const dataDir = path.join(tempRoot, 'data');
    const uploadsDir = path.join(tempRoot, 'uploads');
    const statusPath = path.join(dataDir, 'server-status.json');
    const configPath = path.join(dataDir, 'server-config.json');
    const testMarker = `BROWSER_${Date.now()}`;

    let child = null;
    let browser = null;
    let clientA = null;
    let clientB = null;
    let stderrOutput = '';

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
        child = spawn(process.execPath, ['server.js'], {
            cwd: __dirname,
            env: {
                ...process.env,
                LAN_QT_DATA_DIR: dataDir,
                LAN_QT_UPLOADS_DIR: uploadsDir
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stderr.on('data', chunk => {
            stderrOutput += chunk.toString('utf8');
        });

        await waitForFile(statusPath);
        const status = JSON.parse(await fsp.readFile(statusPath, 'utf8'));
        const baseUrl = status.urls[0];
        assert(status.port !== 18080 && status.port !== 18081, 'Reserved port was not avoided');
        await waitForHttp(baseUrl);
        const qrResponse = await fetch(`${baseUrl}/api/qr.svg?text=${encodeURIComponent(baseUrl)}`);
        assert(qrResponse.ok, 'QR SVG endpoint is not served');
        const qrBody = await qrResponse.text();
        assert(qrBody.includes('<svg') && qrBody.includes('<rect'), 'QR SVG endpoint content is invalid');

        const launchOptions = getBrowserLaunchOptions();
        browser = await chromium.launch(launchOptions);

        clientA = await createClientContext(browser, 'BrowserClientA', '浏览器 A');
        clientB = await createClientContext(browser, 'BrowserClientB', '浏览器 B');

        await Promise.all([
            clientA.page.goto(baseUrl, { waitUntil: 'domcontentloaded' }),
            clientB.page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        ]);
        await Promise.all([
            clientA.page.waitForSelector('#onlineCount'),
            clientB.page.waitForSelector('#onlineCount')
        ]);

        await Promise.all([
            waitForPageText(clientA.page, '#onlineCount', '2 个设备在线'),
            waitForPageText(clientB.page, '#onlineCount', '2 个设备在线')
        ]);

        await clientA.page.fill('#chatInput', `[${testMarker}] 双页面消息`);
        await clientA.page.click('#sendBtn');

        await Promise.all([
            waitForPageText(clientA.page, '#messages', `[${testMarker}] 双页面消息`),
            waitForPageText(clientB.page, '#messages', `[${testMarker}] 双页面消息`)
        ]);

        await clientA.page.click('#btnClearHistory');
        await waitForDialogMessage(clientA.dialogs, message => message.includes('已清空 1 条聊天记录'));
        await Promise.all([
            waitForPageText(clientA.page, '#messages', '记录已被清空'),
            waitForPageText(clientB.page, '#messages', '记录已被清空')
        ]);

        await clientA.page.click('#btnOpenDevices');
        await clientA.page.waitForSelector('.device-alias-input');
        const targetIp = await clientA.page.locator('.device-alias-input').first().getAttribute('data-ip');
        assert(targetIp, 'Failed to locate device IP for alias update');
        const aliasValue = '真实浏览器设备';
        await clientA.page.locator(`.device-alias-input[data-ip="${targetIp}"]`).fill(aliasValue);
        await clientA.page.locator(`button[onclick="saveDeviceAlias('${targetIp}')"]`).click();

        await clientB.page.click('#btnOpenConnect');
        await waitForPageText(clientB.page, '#onlineDeviceList', aliasValue);
        await clientB.page.waitForFunction(
            () => {
                const image = document.getElementById('connectQrImage');
                return image && image.getAttribute('src') && image.getAttribute('src').includes('/api/qr.svg?text=');
            },
            undefined,
            { timeout: 10000 }
        );
        await clientA.page.click('#btnCloseDevices');
        await clientB.page.click('#btnCloseConnect');

        await clientA.page.click('#btnOpenStorage');
        await waitForPageText(clientA.page, '#storageSummary', '当前占用');
        await clientA.page.fill('#retentionDaysInput', '7');
        await clientA.page.fill('#maxStorageGbInput', '2');
        await clientA.page.uncheck('#autoCleanupEnabledInput');
        await clientA.page.click('#btnSaveStorage');
        await waitForDialogMessage(clientA.dialogs, message => message.includes('存储策略已保存'));

        await clientB.page.click('#btnOpenStorage');
        await clientB.page.waitForFunction(
            () => {
                const retention = document.getElementById('retentionDaysInput');
                const limit = document.getElementById('maxStorageGbInput');
                const enabled = document.getElementById('autoCleanupEnabledInput');
                return retention && limit && enabled &&
                    retention.value === '7' &&
                    limit.value === '2' &&
                    enabled.checked === false;
            },
            undefined,
            { timeout: 10000 }
        );
        await clientA.page.click('#btnCloseStorage');
        await clientB.page.click('#btnCloseStorage');

        const uploadedFileName = `browser-${testMarker}.txt`;
        await clientA.page.selectOption('#fileExpireSelect', '1d');
        await clientA.page.setInputFiles('#fileInput', {
            name: uploadedFileName,
            mimeType: 'text/plain',
            buffer: Buffer.from(`browser-upload-${testMarker}`, 'utf8')
        });
        await clientA.page.waitForSelector('.upload-task-item');

        await Promise.all([
            waitForPageText(clientA.page, '#messages', uploadedFileName, 15000),
            waitForPageText(clientB.page, '#messages', uploadedFileName, 15000)
        ]);
        await waitForPageText(clientB.page, '#messages', '保留至', 15000);
        await clientB.page.waitForSelector('.batch-file-check', { timeout: 10000 });
        const batchZipResult = await clientB.page.evaluate(async () => {
            const checkbox = document.querySelector('.batch-file-check');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            const fileInfo = JSON.parse(checkbox.getAttribute('data-batch-file') || '{}');
            const response = await fetch('/api/chat/batch-download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Client-Name': localClientName
                },
                body: JSON.stringify({ files: [fileInfo] })
            });
            const buffer = await response.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buffer.slice(0, 4)));
            return {
                ok: response.ok,
                contentType: response.headers.get('content-type'),
                signature: bytes.map(value => value.toString(16).padStart(2, '0')).join('')
            };
        });
        if (!batchZipResult.ok || batchZipResult.signature !== '504b0304') {
            throw new Error('Batch ZIP download failed.');
        }
        await clientB.page.fill('#fileSearchInput', uploadedFileName);
        await waitForPageText(clientB.page, '#messages', uploadedFileName, 10000);
        await clientB.page.fill('#fileSearchInput', 'no-such-file-for-filter');
        await waitForPageText(clientB.page, '#messages', '没有匹配', 10000);
        await clientB.page.click('#btnClearFilters');
        await waitForPageText(clientB.page, '#messages', uploadedFileName, 10000);
        const lightboxResult = await clientB.page.evaluate(() => {
            lightboxImages.push({
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
                fileName: 'simulated.png'
            });
            openLightbox(lightboxImages.length - 1);
            const active = document.getElementById('imageLightbox').classList.contains('active');
            closeLightbox();
            return active && !document.getElementById('imageLightbox').classList.contains('active');
        });
        if (!lightboxResult) {
            throw new Error('Image lightbox did not open and close correctly.');
        }

        await clientB.page.locator('.tracked-download').last().click();
        await clientB.page.waitForFunction(
            (name) => {
                const panel = document.getElementById('downloadStatus');
                const list = document.getElementById('downloadList');
                return panel && list &&
                    panel.classList.contains('active') &&
                    list.textContent.includes(name);
            },
            uploadedFileName,
            { timeout: 10000 }
        );
        await clientB.page.waitForSelector('[data-download-action="delete"]', { timeout: 10000 });
        const initialDownloadActionLabels = await clientB.page.$$eval('[data-download-action]', buttons => buttons.map(button => button.textContent.trim()));
        if (!initialDownloadActionLabels.includes('删除')) {
            throw new Error('Download delete action was not rendered.');
        }
        const simulatedDownloadActions = await clientB.page.evaluate(() => {
            const pausedId = 'test_paused_download_task';
            const downloadingId = 'test_downloading_download_task';
            downloadTasks.unshift({
                id: pausedId,
                url: '/api/not-found',
                fileName: 'simulated-paused-download.txt',
                loadedBytes: 128,
                totalBytes: 256,
                progress: 50,
                speed: 0,
                remainingSeconds: null,
                status: 'paused',
                error: '',
                chunks: [],
                controller: null,
                contentType: ''
            });
            downloadTasks.unshift({
                id: downloadingId,
                url: '/api/not-found',
                fileName: 'simulated-downloading-download.txt',
                loadedBytes: 0,
                totalBytes: 256,
                progress: 0,
                speed: 0,
                remainingSeconds: null,
                status: 'downloading',
                error: '',
                chunks: [],
                controller: new AbortController(),
                contentType: ''
            });
            renderDownloadTasks();
            const labels = Array.from(document.querySelectorAll('[data-download-action]')).map(button => button.textContent.trim());
            deleteDownloadTask(pausedId);
            deleteDownloadTask(downloadingId);
            return labels;
        });
        if (!simulatedDownloadActions.includes('暂停') || !simulatedDownloadActions.includes('继续下载') || !simulatedDownloadActions.includes('删除')) {
            throw new Error('Download pause/resume/delete actions were not rendered.');
        }
        const queueControlLabels = await clientB.page.$$eval('.download-status-actions button', buttons => buttons.map(button => button.textContent.trim()));
        if (!queueControlLabels.includes('全部暂停') || !queueControlLabels.includes('全部继续') || !queueControlLabels.includes('全部删除')) {
            throw new Error('Download queue controls were not rendered.');
        }
        await clientB.page.locator('[data-download-action="delete"]').first().click();
        await clientB.page.waitForFunction(
            (name) => {
                const list = document.getElementById('downloadList');
                return list && !list.textContent.includes(name);
            },
            uploadedFileName,
            { timeout: 10000 }
        );

        await clientA.page.click('#btnClearFiles');
        await waitForDialogMessage(clientA.dialogs, message => message.includes('已清理'));
        await clientB.page.waitForFunction(
            (name) => !document.getElementById('messages').textContent.includes(name),
            uploadedFileName,
            { timeout: 10000 }
        );

        const report = {
            browserExecutable: launchOptions.executablePath,
            dualPageSync: 'ok',
            realMessageFlow: 'ok',
            clearHistorySync: 'ok',
            aliasSync: 'ok',
            qrCode: 'ok',
            storagePolicyReload: 'ok',
            realUpload: 'ok',
            uploadTaskList: 'ok',
            fileExpiration: 'ok',
            batchZipDownload: 'ok',
            fileSearch: 'ok',
            imageLightbox: 'ok',
            trackedDownload: 'ok',
            downloadActions: 'ok',
            downloadQueueControls: 'ok',
            clearFilesSync: 'ok'
        };

        console.log(JSON.stringify({
            success: true,
            baseUrl,
            port: status.port,
            report
        }, null, 2));
    } catch (err) {
        if (stderrOutput) {
            console.error('Server stderr:\n' + stderrOutput);
        }
        throw err;
    } finally {
        if (clientA) {
            await clientA.context.close().catch(() => {});
        }
        if (clientB) {
            await clientB.context.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
        }
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
