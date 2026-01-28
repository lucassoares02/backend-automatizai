const templateHtml = `<!DOCTYPE html>
<html>

<head>
    <meta charset="UTF-8">
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >
    <title>Cadastro de usuário</title>
    <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
    >
    <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossorigin
    >
    <link
        href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
        rel="stylesheet"
    >
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #f9f9f9;
            margin: 0;
            padding: 0;
            color: #333333;
            line-height: 1.6;
        }

        .email-container {
            max-width: 800px;
            margin: 0 auto;
            background-color: #ffffff !important;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        }

        .header {
            background-color: #B01120;

            /* background: linear-gradient(135deg, #B01120 0%, #b063ff 100%); */
            padding: 30px 25px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }

        .header::after {
            content: "";
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 10px;
            background-color: #B01120;

            /* background: linear-gradient(90deg, #B01120 0%, #b063ff 50%, #B01120 100%); */
        }


        .logo {
            height: 100px;
            /* margin-bottom: 15px; */

        }

        .title {
            color: #ffffff !important;
            font-size: 24px;
            font-weight: 600;
            margin: 0;
        }

        .subtitle {
            color: rgba(255, 255, 255, 0.8);
            font-size: 14px;
            font-weight: 500;
            margin: 8px 0 0;
        }

        .content {
            padding: 30px;
        }

        .greeting {
            font-size: 18px;
            font-weight: 500;
            margin-bottom: 20px;
            color: #B01120;
        }

        .message {
            font-size: 15px;
            margin-bottom: 25px;
            color: #555555;
        }

        .data-section {
            background-color: #f5f2ff;
            border-radius: 8px;
            padding: 20px;
            margin: 25px 0;
        }

        .data-item {
            margin-bottom: 12px;
            display: flex;
        }

        .data-label {
            font-weight: 500;
            color: #666666;
            width: 100px;
        }

        .data-value {
            font-weight: 600;
            color: #B01120;
            flex: 1;
        }

        .button-container {
            text-align: center;
            margin: 30px 0;
        }

        .button {
            display: inline-block;
            /* background: linear-gradient(135deg, #e30613 0%, #B01120 100%); */
            background-color: #e30613;
            color: #ffffff !important;
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            padding: 14px 30px;
            border-radius: 8px;
            transition: all 0.3s ease;
            box-shadow: 0 4px 8px rgba(26, 0, 70, 0.2);
        }

        .button:hover {
            background-color: #B01120;

            /* background: linear-gradient(135deg, #3a1a8a 0%, #B01120 100%); */
            transform: translateY(-2px);
            box-shadow: 0 6px 12px rgba(26, 0, 70, 0.25);
        }

        .footer {
            padding: 20px 30px;
            background-color: #f9f9f9;
            font-size: 12px;
            color: #888888;
            border-top: 1px solid #eeeeee;
        }

        .footer-links {
            margin: 15px 0;
            text-align: center;
        }

        .footer-link {
            color: #B01120;
            text-decoration: none;
            margin: 0 8px;
            font-weight: 500;
        }

        .footer-link:hover {
            text-decoration: underline;
        }

        .confidential {
            font-style: italic;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #eeeeee;
            font-size: 11px;
        }

        .direct-link {
            word-break: break-all;
            margin: 15px 0;
            font-size: 13px;
        }

        @media only screen and (max-width: 600px) {

            .content,
            .footer {
                padding: 20px;
            }

            .data-item {
                flex-direction: column;
            }

            .data-label {
                width: auto;
                margin-bottom: 4px;
            }
        }
    </style>
</head>

<body>
    <div class="email-container">
        <div class="header">

            <h1 class="title">Portal Associados</h1>
            <p class="subtitle">Cadastro de usuário</p>
        </div>

        <div class="content">

            <div>
                <img
                    src="https://multishowsupermercados.com.br/wp-content/uploads/2023/03/ICON.png"
                    alt="Ayko Logo"
                    class="logo"
                >
            </div>

            <p class="greeting">Olá, @name!</p>

            <p class="message">Estamos passando pra informar que foi realizado o seu cadastro para acesso a plataforma dos associados do Grupo Multishow.</p>

            <p class="message">Segue abaixo os dados para acessar a plataforma.</p>

            <div class="data-section">
                <div class="data-item">
                    <span class="data-label">E-mail:</span>
                    <span class="data-value">@email</span>
                </div>
            </div>

            <p class="message">Acesse a plataforma através do botão abaixo:</p>

            <div class="button-container">
                <a
                    href="@link"
                    class="button"
                >Acessar</a>
            </div>

            <p class="direct-link">Se o botão não funcionar, copie e cole este link em seu navegador:<br>
                <a
                    href="@link"
                    style="color: #B01120;"
                >@link</a>
            </p>
        </div>

        <div class="footer">
            <p class="confidential">
                <strong>Notificação de Confidencialidade:</strong><br>
                O conteúdo deste e-mail é confidencial e destinado exclusivamente ao destinatário. É proibido compartilhar esta mensagem sem consentimento. Se recebeu esta mensagem por engano, exclua-a imediatamente.
            </p>
        </div>
    </div>
</body>

</html>`;

module.exports = { templateHtml };
