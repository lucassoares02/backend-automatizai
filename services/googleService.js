const axios = require("axios");

const apiKey = process.env.GOOGLE_API_KEY;

async function buscarEndereco(termo, cidade) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json`;

  try {
    const response = await axios.get(url, {
      params: {
        query: `${termo}, ${cidade}`,
        key: apiKey,
        language: "pt-BR",
      },
    });

    // Se não houver resultados diretos, tente uma busca mais ampla sem a cidade na query
    // ou verifique se o Google retornou "zero_results"
    if (response.data.status === "ZERO_RESULTS") {
      console.log(`Tentando busca global para: ${termo}`);
      // Aqui você poderia fazer um novo retry sem o parâmetro da cidade
      return;
    }

    if (response.data.results.length > 0) {
      const local = response.data.results;
      return local;
    }
  } catch (error) {
    console.error("Erro na busca:", error.message);
    return res.status(400).json({ error: "Erro ao buscar endereço" });
  }
}

module.exports = { buscarEndereco };
