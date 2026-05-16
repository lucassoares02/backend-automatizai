const Minio = require("minio");

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "files.iasemburocracia.com.br",
  // port: parseInt(process.env.MINIO_PORT) || 443,
  useSSL: true,
  accessKey: process.env.MINIO_ACCESS_KEY || "admin",
  secretKey: process.env.MINIO_SECRET_KEY || "12345678",
});

const BUCKET = process.env.MINIO_BUCKET || "iasemburocracia";

/**
 * Faz upload de um arquivo para o MinIO
 * @param {Buffer} fileBuffer - Conteúdo do arquivo
 * @param {string} fileName - Caminho/nome do arquivo no bucket (ex: "logos/logo.png")
 * @param {string} contentType - MIME type (ex: "image/png")
 * @returns {Promise<{ url: string, etag: string }>}
 */
async function uploadFile(fileBuffer, fileName, contentType = "application/octet-stream") {
  try {
    const metaData = { "Content-Type": contentType };

    console.log(`Iniciando upload: ${fileName} (${contentType})`);

    const result = await minioClient.putObject(BUCKET, fileName, fileBuffer, fileBuffer.length, metaData);

    const url = `https://${minioClient.host}/${BUCKET}/${fileName}`;

    console.log(`Arquivo enviado: ${fileName}`);
    return { url, etag: result.etag };
  } catch (error) {
    console.log(`Erro no upload: ${error.message}`);
    throw error;
  }
}

/**
 * Gera uma URL pública permanente para o arquivo
 * (funciona se o bucket tiver política de acesso público)
 * @param {string} fileName - Caminho do arquivo no bucket
 * @returns {string}
 */
function getFileUrl(fileName) {
  return `https://${minioClient.host}/${BUCKET}/${fileName}`;
}

/**
 * Gera uma URL temporária com expiração (para buckets privados)
 * @param {string} fileName - Caminho do arquivo no bucket
 * @param {number} expiry - Tempo em segundos (padrão: 1h)
 * @returns {Promise<string>}
 */
async function getPresignedUrl(fileName, expiry = 3600) {
  try {
    const url = await minioClient.presignedGetObject(BUCKET, fileName, expiry);
    return url;
  } catch (error) {
    console.log(`Erro ao gerar URL temporária: ${error.message}`);
    throw error;
  }
}

/**
 * Baixa o arquivo como Buffer
 * @param {string} fileName - Caminho do arquivo no bucket
 * @returns {Promise<Buffer>}
 */
async function getFile(fileName) {
  try {
    const stream = await minioClient.getObject(BUCKET, fileName);
    const chunks = [];

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  } catch (error) {
    console.log(`Erro ao buscar arquivo: ${error.message}`);
    throw error;
  }
}

/**
 * Remove um arquivo do MinIO
 * @param {string} fileName - Caminho do arquivo no bucket
 */
async function deleteFile(fileName) {
  try {
    await minioClient.removeObject(BUCKET, fileName);
    console.log(`Arquivo removido: ${fileName}`);
  } catch (error) {
    console.log(`Erro ao remover arquivo: ${error.message}`);
    throw error;
  }
}

module.exports = {
  minioClient,
  uploadFile,
  getFileUrl,
  getPresignedUrl,
  getFile,
  deleteFile,
};
