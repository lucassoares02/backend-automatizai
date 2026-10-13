#!/bin/bash

set -e

echo "📦 Adicionando alterações..."
git add .

if git diff --cached --quiet; then
    echo "ℹ️ Nenhuma alteração para commit."
else
    echo "💾 Criando commit..."
    git commit -m "add changes"
fi

# Sempre envia: um commit local de uma execução anterior (push que falhou)
# ficaria de fora do deploy.
echo "🚀 Enviando para o Git..."
git push origin main

echo "🔐 Conectando ao servidor..."
ssh -x root@147.93.12.83 "cd /opt/arbian && ./deploy.sh"

echo "✅ Deploy concluído!"

echo ""