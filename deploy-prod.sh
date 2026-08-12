#!/bin/bash

set -e

echo "📦 Adicionando alterações..."
git add .

echo "💾 Criando commit..."
git commit -m "add changes"

echo "🚀 Enviando para o Git..."
git push origin main

echo "🔐 Conectando ao servidor..."
ssh root@89.167.90.225 "cd /srv/app && ./deploy"

echo "✅ Deploy concluído!"
