# API — Node.js

## Stack

- **Runtime:** Node.js com Express 5
- **Banco:** PostgreSQL via `pg` (Pool) — conexão em `db.js`
- **Auth:** JWT (`helpers/jwt.js`) + bcrypt (`helpers/hash.js`)
- **Upload:** Multer (memoryStorage) + MinIO (`minio` SDK)
- **Email:** Nodemailer (`controllers/maillerController.js`)
- **Variáveis de ambiente:** dotenv (`.env` na raiz da api)

## Estrutura de pastas

```
api/
├── index.js                  # Entry point: Express, CORS, montagem das rotas em /api/
├── db.js                     # Pool PostgreSQL (POSTGRESQL_EXTERNAL_URL)
├── src/
│   ├── routes.js             # Todas as rotas declaradas aqui
│   └── middlewares/
│       └── middleware.js     # authMiddleware — valida JWT no header Authorization
├── controllers/              # Lógica de req/res; chama services
│   ├──
├── services/                 # Regras de negócio e queries SQL
│   ├──
└── helpers/
    ├── jwt.js                # generateToken / verifyToken
    └── hash.js               # hashPassword / comparePassword / sendPasswordEmail
```

## Rotas existentes (prefixo `/api`)

| Recurso | Endpoints principais | Auth |
| ------- | -------------------- | ---- |
| Auth    | `POST /signin`       | Não  |
| Users   | `GET/POST /users`    | GET  |

## Convenções obrigatórias

- **Nova funcionalidade:** criar `controllers/xyzController.js` + `services/xyzService.js` + registrar rotas em `src/routes.js`
- **Resposta padrão:** `{ success: boolean, data: any, error: string | null }`
- **Erros:** sempre `try/catch`; nunca deixar exceção não tratada chegar ao Express
- **Banco:** acesso ao PostgreSQL **somente** via `services/`; importar `db.js` nos services
- **Auth:** rotas protegidas usam `authMiddleware` (segundo argumento do `router.method`)
- **Upload de arquivos:** usar `upload.single("file")` do multer antes do controller

## Variáveis de ambiente necessárias

```
POSTGRESQL_EXTERNAL_URL=   # connection string do PostgreSQL
JWT_SECRET=                # segredo para assinar tokens
ORIGIN=                    # origem permitida no CORS
PORT=                      # porta (default 3003)
```
