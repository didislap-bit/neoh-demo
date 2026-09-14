// Lê o JSON embutido no <script id="eapData"> do cronograma publicado
// e grava esse conteúdo na tabela cronograma_estado do Supabase.
// Roda automaticamente via GitHub Actions a cada push que altere o HTML.
//
// IMPORTANTE: este script faz MESCLAGEM, não sobrescrita total.
// O arquivo HTML publicado só conhece eap/macro/resumo/generated/ritos/solicitacoes
// (o que veio das planilhas). Ele NUNCA contém o "plano de ação" (actionPlan) nem
// as confirmações de presença em reunião (o campo "respostas" dentro de cada rito),
// porque essas coisas só existem quando alguém usa o app ao vivo. Se a gente
// simplesmente sobrescrevesse a linha do Supabase com o que está no arquivo,
// perderíamos o plano de ação inteiro e todas as confirmações de reunião a cada
// publicação — foi exatamente isso que aconteceu antes desta correção.

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

let fileDados;
try {
  fileDados = JSON.parse(match[1]);
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

function slug(nome) {
  return String(nome || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Junta os ritos novos (vindos do arquivo/planilha) com as respostas de presença
// que já existiam no banco, casando por nome do rito. Assim a definição do rito
// (dia, horário, cadência) vem sempre do arquivo mais recente, mas quem já
// confirmou presença continua confirmado.
function mergeRitos(fileRitos, dbRitos) {
  const dbByNome = new Map((dbRitos || []).map((r) => [slug(r.nome), r]));
  return (fileRitos || []).map((r) => {
    const dbMatch = dbByNome.get(slug(r.nome));
    if (dbMatch && Array.isArray(dbMatch.respostas) && dbMatch.respostas.length > 0) {
      return { ...r, respostas: dbMatch.respostas };
    }
    return r;
  });
}

async function publish() {
  // 1) busca o que já está salvo, para não perder plano de ação / confirmações
  const getResp = await fetch(`${endpoint}?id=eq.1&select=dados`, {
    method: "GET",
    headers,
  });

  let dbDados = null;
  if (getResp.ok) {
    const rows = await getResp.json();
    if (Array.isArray(rows) && rows.length > 0) {
      dbDados = rows[0].dados || null;
    }
  } else {
    console.warn("Não consegui ler o estado atual do Supabase antes de publicar (seguindo mesmo assim):", getResp.status);
  }

  const dados = {
    ...fileDados,
    ritos: mergeRitos(fileDados.ritos, dbDados ? dbDados.ritos : null),
    solicitacoes:
      dbDados && Array.isArray(dbDados.solicitacoes) && dbDados.solicitacoes.length > 0
        ? dbDados.solicitacoes
        : fileDados.solicitacoes,
    actionPlan: dbDados && Array.isArray(dbDados.actionPlan) ? dbDados.actionPlan : [],
  };

  // 2) tenta atualizar a linha id=1 existente
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
    console.log("✅ Linha atualizada com sucesso (id=1) — plano de ação e confirmações de reunião preservados.");
    return;
  }

  // 3) nenhuma linha existente ainda: cria (upsert)
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
