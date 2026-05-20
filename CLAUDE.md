# API Node.js (Express + PostgreSQL)

## Stack atual

- Runtime: Node.js + Express 5
- Banco: PostgreSQL via `pg` (pool em `db.js`)
- Autenticação: JWT (`helpers/jwt.js`) + middleware `src/middlewares/middleware.js`
- Hash de senha: `bcrypt` (`helpers/hash.js`)
- Email: Nodemailer (`services/mailerService.js` + `controllers/maillerController.js`)
- Integrações externas: N8N, Evolution, Google Geocoding, MinIO
- Configuração: dotenv (`.env` na raiz)

## Estrutura do projeto

```txt
api/
├── index.js                  # Bootstrap do Express + CORS + /api + error handler global
├── db.js                     # Pool PostgreSQL
├── src/
│   ├── routes.js             # Registro de todas as rotas
│   └── middlewares/
│       └── middleware.js     # authMiddleware (JWT via Authorization: Bearer)
├── controllers/              # Camada HTTP (req/res, validação básica, status code)
├── services/                 # Regras de negócio, SQL e chamadas externas
├── helpers/                  # utilitários (jwt/hash)
└── templates/                # templates auxiliares (ex.: JSON base)
```

## Padrão arquitetural

- Fluxo principal: `route -> controller -> service`
- Controller não deve conter SQL direto; acesso ao banco fica em `services/*`
- Rotas são centralizadas em `src/routes.js` com prefixo `/api`
- Rotas protegidas devem usar `authMiddleware` como segundo argumento

## Rotas implementadas (prefixo `/api`)

- Health: `GET /`
- Auth: `POST /signin`
- Users: `GET /users` (auth), `POST /users`
- Mail: `POST /send-email`
- Register/Companies:
  `POST /register`, `POST /companies/withoutid` (auth), `POST /companies`, `GET /cnpj/:cnpj`
- Companies:
  `GET /companies` (auth), `PATCH /companies` (auth), `GET /companies/:company` (auth), `GET /providers/city/:company` (auth)
- Account: `GET /account` (auth), `PATCH /account` (auth)
- Company opening hours (CRUD)
- Menu categories (CRUD)
- Menu items (CRUD + `GET /menu_items/company/:id`)
- Company address: `GET /company/address/:id`, `PATCH /company/address`
- Companiessss (CRUD)
- Payment methods (CRUD + `GET /payment_methods/company/:id`)
- Connections:
  `GET /connections/all/:company`, `GET /connections/:id`, `POST /connections`, `PATCH /connections/:id`, `DELETE /connections/:id/:instance`, `POST /search-address`
- Additional info:
  `GET /additional_info/company/:id`, `GET /additional_info/:id`, `POST /additional_info`, `PATCH /additional_info/:id`, `DELETE /additional_info/:id`

## Convenções do código atual

- Tratamento de erro por controller com `try/catch`; retornar `4xx/5xx` com `{ error: string }`
- Não há envelope único obrigatório de resposta; manter o formato já usado no módulo alterado
- Middleware global de erro existe em `index.js` e responde `{ success: false, message }`
- Logs simples via `console.log/console.error` já são padrão no projeto

## Variáveis de ambiente usadas no código

```env
# Core
POSTGRESQL_EXTERNAL_URL=
JWT_SECRET=
ORIGIN=
PORT=
ENVIROMENT=

# N8N / Evolution
URL_N8N=
TOKEN_N8N=
EVOLUTION_API_URL=
TOKEN_EVOLUTION=

# Email
MAIL_HOST=
MAIL_PORT=
MAIL_SECURE=
MAIL_USER=
MAIL_PASS=
MAIL_FROM=

# Google
GOOGLE_API_KEY=

# MinIO
MINIO_ENDPOINT=
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_BUCKET=
```

## Checklist para novas features

- Criar `controllers/<recurso>Controller.js`
- Criar `services/<recurso>Service.js`
- Registrar endpoints em `src/routes.js`
- Aplicar `authMiddleware` quando a rota exigir autenticação
- Garantir `try/catch` e códigos HTTP coerentes
- Se houver banco, usar `db.js` apenas na camada de service
- Para upload/armazenamento/remoção de arquivos, reutilizar `controllers/minioController.js` (`uploadFile`, `getFileUrl`, `getPresignedUrl`, `getFile`, `deleteFile`)
