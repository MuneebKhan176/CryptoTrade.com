const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { 
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    }
});

function sendVerificationEmail(toEmail, code) {
    return transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: toEmail,
        subject: "Verify your email",
        text: `Your verification code is ${code}. It expires in 10 minutes.`,

        html: `
        <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:30px;">
            <div style="max-width:500px; margin:auto; background:#ffffff; padding:25px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">

                <h2 style="text-align:center; color:#333;">Email Verification</h2>

                <p style="font-size:15px; color:#555;">
                    Hello 👋,<br><br>
                    Use the verification code below to complete your signup.
                </p>

                <div style="text-align:center; margin:25px 0;">
                    <span style="
                        display:inline-block;
                        font-size:26px;
                        letter-spacing:6px;
                        font-weight:bold;
                        background:#f0f0f0;
                        padding:12px 20px;
                        border-radius:8px;
                        color:#111;
                    ">
                        ${code}
                    </span>
                </div>

                <p style="font-size:14px; color:#777; text-align:center;">
                    This code will expire in <b>10 minutes</b>.
                </p>

                <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">

                <p style="font-size:12px; color:#999; text-align:center;">
                    If you didn’t request this email, you can safely ignore it.
                </p>

            </div>
        </div>
        `
    });
}

module.exports = sendVerificationEmail;