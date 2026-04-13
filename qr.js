const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const {
    default: Maher_Zubair,
    useMultiFileAuthState,
    Browsers,
    delay,
} = require("maher-zubair-baileys");

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

router.get('/', async (req, res) => {
    const id = makeid();

    async function SAHIL_804_QR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
            let sock = Maher_Zubair({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Desktop"),
            });

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect, qr } = s;

                if (qr) await res.end(await QRCode.toBuffer(qr));

                if (connection === "open") {
                    await delay(5000);
                    let data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
                    await delay(800);
                    let b64data = Buffer.from(data).toString('base64');
                    let session = await sock.sendMessage(sock.user.id, { text: "" + b64data });

                    let successMsg =
`╔══════════════════════════════════╗
║   🔗 𝑫𝑬𝑽𝑰𝑪𝑬 𝑳𝑰𝑵𝑲𝑬𝑫 𝑺𝑼𝑪𝑪𝑬𝑺𝑺𝑭𝑼𝑳𝑳𝒀!  ║
╚══════════════════════════════════╝

❶ 𝑩𝒐𝒕  : 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 🤖
❷ 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒 👑
❸ 𝑾𝒉𝒂𝒕𝒔𝑨𝒑𝒑 : wa.me/923496049312
❹ 𝑩𝒂𝒄𝒌𝒖𝒑  : wa.me/923711158307
❺ 𝑪𝒉𝒂𝒏𝒏𝒆𝒍 : https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l
❻ 𝑬𝒎𝒂𝒊𝒍  : sahilhackerx110@gmail.com

📋 𝑻𝒚𝒑𝒆 .𝒎𝒆𝒏𝒖 𝒕𝒐 𝒔𝒆𝒆 𝒂𝒍𝒍 𝒄𝒐𝒎𝒎𝒂𝒏𝒅𝒔!

𝑻𝒉𝒂𝒏𝒌 𝒚𝒐𝒖 𝒇𝒐𝒓 𝒖𝒔𝒊𝒏𝒈 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 🔥
𝑷𝒐𝒘𝒆𝒓𝒆𝒅 𝒃𝒚 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒 💙`;

                    await sock.sendMessage(sock.user.id, { text: successMsg }, { quoted: session });
                    await delay(100);
                    await sock.ws.close();
                    return await removeFile("temp/" + id);

                } else if (
                    connection === "close" &&
                    lastDisconnect &&
                    lastDisconnect.error &&
                    lastDisconnect.error.output.statusCode !== 401
                ) {
                    await delay(10000);
                    SAHIL_804_QR_CODE();
                }
            });

        } catch (err) {
            if (!res.headersSent) {
                await res.json({ code: "Service Unavailable" });
            }
            console.log(err);
            await removeFile("temp/" + id);
        }
    }

    return await SAHIL_804_QR_CODE();
});

module.exports = router;
                  
