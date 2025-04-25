const express = require('express');
const puppeteer = require('puppeteer');
process.env.PUPPETEER_CACHE_DIR = '/opt/render/.cache/puppeteer';
const app = express();

app.get('/heatmap', async (req, res) => {
    const symbols = ['BTC', 'ETH'];
    const results = { btc: [], eth: [] };

    let browser;
    try {
        // Phân biệt môi trường local và Render
        const isRender = process.env.RENDER === 'true'; // Render tự thêm biến RENDER=true
        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--start-maximized',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials'
            ]
        };

        // Nếu chạy trên Render, thêm executablePath
        if (isRender) {
            launchOptions.executablePath = '/opt/render/.cache/puppeteer/chrome/linux-135.0.7049.114/chrome-linux64/chrome';
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // 💡 Chỉ làm 1 lần lúc đầu
        console.log('🌐 Load trang và setup ban đầu...');
        await page.goto('https://www.coinglass.com/vi/pro/futures/LiquidationHeatMap', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            const closeButtons = [...document.querySelectorAll('button, div')];
            const closeButton = closeButtons.find(btn => btn.innerText.includes('X') || btn.innerText.includes('Đóng'));
            if (closeButton) closeButton.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button')];
            const symbolButton = buttons.find(btn => btn.innerText.includes('Ký hiệu'));
            if (symbolButton) symbolButton.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            const comboboxes = document.querySelectorAll('button[role="combobox"]');
            if (comboboxes[1]) comboboxes[1].click();
        });
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate(() => {
            const items = [...document.querySelectorAll('li')];
            const twelveHours = items.find(li => li.innerText.trim() === '12 giờ');
            if (twelveHours) twelveHours.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // 🔁 Lặp từng symbol
        for (const symbol of symbols) {
            let minLiq = symbol === 'BTC' ? 50000000 : 500000;

            console.log(`📌 Chọn symbol ${symbol}`);
            const inputSelector = 'input[role="combobox"]';
            await page.waitForSelector(inputSelector, { timeout: 1000 });
            await page.click(inputSelector);
            await page.evaluate(() => { document.querySelector('input[role="combobox"]').value = ''; });
            await page.type(inputSelector, symbol);
            await new Promise(r => setTimeout(r, 1000));

            const symbolSelected = await page.evaluate((sym) => {
                const items = [...document.querySelectorAll('li')];
                const target = items.find(li => li.innerText.trim().toUpperCase().includes(sym));
                if (target) { target.click(); return true; }
                return false;
            }, symbol);
            if (!symbolSelected) throw new Error(`Không tìm thấy ${symbol} trong dropdown`);
            await new Promise(r => setTimeout(r, 1000));

            await page.evaluate(() => {
                const canvas = document.querySelector('canvas[data-zr-dom-id="zr_0"]');
                if (canvas) canvas.scrollIntoView();
            });
            await new Promise(r => setTimeout(r, 1000));

            const canvasInfo = await page.evaluate(() => {
                const canvas = document.querySelector('canvas[data-zr-dom-id="zr_0"]');
                if (!canvas) return { exists: false, width: 0, height: 0, left: 0, top: 0 };
                const rect = canvas.getBoundingClientRect();
                return { exists: true, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
            });
            if (!canvasInfo.exists || canvasInfo.width === 0) throw new Error(`Canvas không sẵn sàng cho ${symbol}`);

            const { results: data } = await page.evaluate(async (symbol, canvasInfo, minLiq) => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                async function waitForTooltipText(maxWaitMs = 1000) {
                    const start = Date.now();
                    while (Date.now() - start < maxWaitMs) {
                        const tooltip = document.querySelector('.cg-toolti-box') || document.querySelector('[class*="tooltip"]');
                        if (tooltip && tooltip.innerText.trim()) return tooltip.innerText;
                        await sleep(50);
                    }
                    return '';
                }

                const canvas = document.querySelector('canvas[data-zr-dom-id="zr_0"]');
                if (!canvas) return { results: [] };
                const results = [];

                for (let i = 20; i <= 130; i++) {
                    const x = canvasInfo.left + canvasInfo.width * 0.95;
                    const y = canvasInfo.top + canvasInfo.height * 0.1 + i * (canvasInfo.height * 0.005);
                    const evt = new MouseEvent('mousemove', { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y });
                    canvas.dispatchEvent(evt);
                    await sleep(100);

                    const tooltipText = await waitForTooltipText();
                    if (!tooltipText) continue;

                    const lines = tooltipText.split('\n');
                    let price = null;
                    let liq = null;

                    for (let i = 0; i < lines.length - 1; i++) {
                        if (lines[i].trim() === 'Giá') {
                            price = parseFloat(lines[i + 1].replace(/,/g, '')).toFixed(0);
                        }
                        if (lines[i].toLowerCase().includes('đòn đòi nợ')) {
                            liq = lines[i + 1].trim();
                        }
                    }

                    if (!price || !liq) continue;

                    const raw = liq.toUpperCase().replace(/,/g, '');
                    const multiplier = raw.endsWith('K') ? 1e3 : raw.endsWith('M') ? 1e6 : raw.endsWith('B') ? 1e9 : 1;
                    const liqValue = parseFloat(raw.replace(/[KMB]$/, '')) * multiplier;

                    if (liqValue > minLiq && !results.some(r => r.price === price)) {
                        results.push({ price, liquidate: liq });
                    }
                }

                results.sort((a, b) => {
                    const getLiq = (liq) => {
                        liq = liq.toUpperCase().replace(/,/g, '');
                        const m = liq.endsWith('K') ? 1e3 : liq.endsWith('M') ? 1e6 : liq.endsWith('B') ? 1e9 : 1;
                        return parseFloat(liq.replace(/[KMB]$/, '')) * m;
                    };
                    return getLiq(b.liquidate) - getLiq(a.liquidate);
                });

                return { results };
            }, symbol, canvasInfo, minLiq);

            if (symbol === 'BTC') results.btc = data;
            else results.eth = data;
        }

        await browser.close();
        return res.json({ data: results });
    } catch (err) {
        console.error(`❌ Lỗi lấy heatmap:`, err);
        if (browser) await browser.close();
        return res.status(500).json({ error: `Lỗi lấy heatmap: ${err.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send('Server đang chạy! Truy cập /heatmap để lấy dữ liệu.');
});
app.listen(PORT, () => console.log(`🔥 Server chạy tại http://localhost:${PORT}`));
