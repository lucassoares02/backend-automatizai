#!/bin/bash

set -e

echo "📦 Adicionando alterações..."
git add .

if git diff --cached --quiet; then
    echo "ℹ️ Nenhuma alteração para commit."
else
    echo "💾 Criando commit..."
    git commit -m "add changes"

    echo "🚀 Enviando para o Git..."
    git push origin main
fi

echo "🔐 Conectando ao servidor..."
ssh -x root@147.93.12.83 "cd /srv/app && ./deploy.sh"

echo "✅ Deploy concluído!"

echo ""