// Lê o JSON embutido no <script id="eapData"> do cronograma publicado
// e grava esse conteúdo na tabela cronograma_estado do Supabase.
// Roda automaticamente via GitHub Actions a cada push que altere o HTML.

import { readFileSync } from "node:fs";

const HTML_PATH = process.env.CRONOGRAMA_HTML_PATH || "Cronograma_Neoh_Orizonti_publicavel.html";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Faltam as variáveis de ambiente SUPABASE_URL / SUPABASE_KEY.");
  process.exit(1);
}

let html;
try {
  html = readFileSync(HTML_PATH, "utf8");
} catch (err) {
  console.error(`Não consegui ler o arquivo "${HTML_PATH}":`, err.message);
  process.exit(1);
}

const match = html.match(
  /<script id="eapData" type="application\/json">([\s\S]*?)<\/script>/
);
if (!match) {
  console.error('Não encontrei a tag <script id="eapData"> no arquivo.');
  process.exit(1);
}

let dados;
try {
  dados = JSON.parse(match[1]);
} catch (err) {
  console.error("O conteúdo da tag eapData não é um JSON válido:", err.message);
  process.exit(1);
}

const endpoint = `${SUPABASE_URL}/rest/v1/cronograma_estado`;
const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function publish() {
  // 1) tenta atualizar a linha id=1 existente
  const updateResp = await fetch(`${endpoint}?id=eq.1`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ dados, atualizado_em: new Date().toISOString() }),
  });

  if (!updateResp.ok) {
    const text = await updateResp.text();
    console.error("Falha ao atualizar (PATCH):", updateResp.status, text);
    process.exit(1);
  }

  const updated = await updateResp.json();
  if (Array.isArray(updated) && updated.length > 0) {
    console.log("✅ Linha atualizada com sucesso (id=1).");
    return;
  }

  // 2) nenhuma linha existente ainda: cria (upsert)
  console.log("Nenhuma linha existente com id=1 — criando...");
  const upsertResp = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: 1, dados, atualizado_em: new Date().toISOString() }),
  });

  if (!upsertResp.ok) {
    const text = await upsertResp.text();
    console.error("Falha ao criar (POST/upsert):", upsertResp.status, text);
    process.exit(1);
  }

  console.log("✅ Linha criada com sucesso (id=1).");
}

publish().catch((err) => {
  console.error("Erro inesperado:", err);
  process.exit(1);
});
