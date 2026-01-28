const nodemailer = require('nodemailer');

const sendEmailSmtp = async (from, to, subject, text, html) => {
    const transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: Number(process.env.MAIL_PORT) || 587,
        secure: process.env.MAIL_SECURE === 'true',
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS,
        },
    });

    try {
        await transporter.verify();
        console.log('Conexão SMTP estabelecida com sucesso');
    } catch (err) {
        console.error('Erro ao verificar conexão SMTP:', err);
        throw new Error('Erro ao verificar conexão SMTP');
    }

    const info = await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
    });

    return info;

};

module.exports = { sendEmailSmtp };
