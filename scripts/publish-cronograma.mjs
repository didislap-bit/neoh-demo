// Lê o JSON embutido no <script id="eapData"> do cronograma publicado
// e grava esse conteúdo na tabela cronograma_estado do Supabase.
// Roda automaticamente via GitHub Actions a cada push que altere o HTML.
//
// IMPORTANTE #1 — MESCLAGEM, não sobrescrita total.
// O arquivo HTML publicado só conhece eap/macro/resumo/generated/ritos/solicitacoes
// (o que veio das planilhas). Ele NUNCA contém o "plano de ação" (actionPlan) nem
// as confirmações de presença em reunião (o campo "respostas" dentro de cada rito),
// porque essas coisas só existem quando alguém usa o app ao vivo. Se a gente
// simplesmente sobrescrevesse a linha do Supabase com o que está no arquivo,
// perderíamos o plano de ação inteiro e todas as confirmações de reunião a cada
// publicação.
//
// IMPORTANTE #2 — CONCORRÊNCIA: e se alguém estiver salvando uma alteração no
// app bem no instante em que esta Action publica? Sem proteção, a sequência
// "ler → mesclar → gravar" corre o risco de gravar por cima de um salvamento
// que aconteceu logo depois da leitura, apagando silenciosamente o que a
// pessoa acabou de fazer. Para evitar isso, a gravação é CONDICIONAL: só
// grava se a coluna atualizado_em ainda for exatamente igual à que foi lida
// no início (ninguém mexeu enquanto isso). Se alguém mexeu no meio do
// caminho, a gravação não afeta nenhuma linha (0 rows) — nesse caso,
// lemos de novo (agora já com a alteração da pessoa) e tentamos publicar
// de novo, até algumas vezes.

import { readFileSync } from "node:fs";

const HTML_PATH = process.env.CRONOGRAMA_HTML_PATH || "Cronograma_Neoh_Orizonti_publicavel.html";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAX_TENTATIVAS = 5;

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
// que já existiam no banco, casando por nome do rito.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lerEstadoAtual() {
  const resp = await fetch(`${endpoint}?id=eq.1&select=dados,atualizado_em`, {
    method: "GET",
    headers,
  });
  if (!resp.ok) {
    console.warn("Não consegui ler o estado atual do Supabase:", resp.status);
    return { dados: null, atualizado_em: null };
  }
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { dados: null, atualizado_em: null };
  }
  return { dados: rows[0].dados || null, atualizado_em: rows[0].atualizado_em ?? null };
}

function montarDadosMesclados(dbDados) {
  return {
    ...fileDados,
    ritos: mergeRitos(fileDados.ritos, dbDados ? dbDados.ritos : null),
    solicitacoes:
      dbDados && Array.isArray(dbDados.solicitacoes) && dbDados.solicitacoes.length > 0
        ? dbDados.solicitacoes
        : fileDados.solicitacoes,
    actionPlan: dbDados && Array.isArray(dbDados.actionPlan) ? dbDados.actionPlan : [],
  };
}

async function publish() {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const { dados: dbDados, atualizado_em: atualizadoEmLido } = await lerEstadoAtual();
    const dados = montarDadosMesclados(dbDados);
    const agora = new Date().toISOString();

    // Gravação condicional: só afeta a linha se atualizado_em ainda for exatamente
    // o valor que acabamos de ler. Se alguém salvou algo entre a leitura e esta
    // gravação, o filtro não bate com nenhuma linha e o Supabase devolve um array
    // vazio — sinal de que precisamos ler de novo (já com a alteração da pessoa)
    // e tentar publicar mais uma vez, em vez de gravar por cima.
    let url = `${endpoint}?id=eq.1`;
    if (atualizadoEmLido) {
      url += `&atualizado_em=eq.${encodeURIComponent(atualizadoEmLido)}`;
    }

    const updateResp = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ dados, atualizado_em: agora }),
    });

    if (!updateResp.ok) {
      const text = await updateResp.text();
      console.error(`Falha ao atualizar (tentativa ${tentativa}/${MAX_TENTATIVAS}):`, updateResp.status, text);
      process.exit(1);
    }

    const updated = await updateResp.json();
    if (Array.isArray(updated) && updated.length > 0) {
      console.log(
        `✅ Linha atualizada com sucesso (tentativa ${tentativa}/${MAX_TENTATIVAS}) — ` +
        `plano de ação e confirmações de reunião preservados, sem conflito de concorrência.`
      );
      return;
    }

    if (!atualizadoEmLido) {
      // Não havia linha id=1 ainda (primeira publicação) — cria via upsert, sem
      // necessidade de checar concorrência.
      console.log("Nenhuma linha existente com id=1 — criando...");
      const upsertResp = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ id: 1, dados, atualizado_em: agora }),
      });
      if (!upsertResp.ok) {
        const text = await upsertResp.text();
        console.error("Falha ao criar (POST/upsert):", upsertResp.status, text);
        process.exit(1);
      }
      console.log("✅ Linha criada com sucesso (id=1).");
      return;
    }

    // atualizado_em mudou entre a leitura e a gravação: alguém salvou algo no
    // meio do caminho. Espera um instante e tenta de novo com dados frescos.
    console.warn(
      `⚠️ Conflito de concorrência detectado (tentativa ${tentativa}/${MAX_TENTATIVAS}): ` +
      `alguém salvou uma alteração no app durante a publicação. Lendo de novo e tentando novamente...`
    );
    await sleep(700);
  }

  console.error(
    `❌ Não foi possível publicar após ${MAX_TENTATIVAS} tentativas: o cronograma está sendo ` +
    `editado ativamente no app com muita frequência. Rode a Action de novo em alguns minutos.`
  );
  process.exit(1);
}

publish().catch((err) => {
  console.error("Erro inesperado:", err);
  process.exit(1);
});
