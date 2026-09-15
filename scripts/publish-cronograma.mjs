// Lê o JSON embutido no <script id="eapData"> do cronograma publicado
// e grava esse conteúdo na tabela cronograma_estado do Supabase.
// Roda automaticamente via GitHub Actions a cada push que altere o HTML.
//
// IMPORTANTE #1 — MESCLAGEM de actionPlan / ritos / solicitações.
// O arquivo HTML publicado só conhece eap/macro/resumo/generated/ritos/solicitacoes
// (o que veio das planilhas). Ele NUNCA contém o "plano de ação" (actionPlan) nem
// as confirmações de presença em reunião (o campo "respostas" dentro de cada rito),
// porque essas coisas só existem quando alguém usa o app ao vivo. O script sempre
// preserva o que já estiver salvo no Supabase para esses campos.
//
// IMPORTANTE #2 — CONCORRÊNCIA. A gravação é CONDICIONAL: só grava se
// atualizado_em ainda for exatamente igual ao que foi lido no início. Se
// mudou, lê de novo e tenta publicar de novo, até algumas vezes.
//
// IMPORTANTE #3 — MERGE NÓ A NÓ DA EAP (esta é a parte nova). Antes desta
// versão, TODA a árvore eap/macro do arquivo sobrescrevia o que estava no
// Supabase — inclusive atividades que alguém tinha acabado de editar pelo
// app (por exemplo, marcar uma atividade como 100% concluída). Isso já
// causou perda de dados reais e de credibilidade com o cliente.
//
// Agora, cada nó da EAP que já existe no Supabase carrega um campo
// "editado_em" (a hora exata em que alguém editou aquele item específico
// pelo app). O arquivo carrega um "generated_at" (a hora em que este
// arquivo foi gerado a partir das planilhas). A regra de mesclagem é:
//
//   Para cada código de item da EAP:
//     - Se o item existe no Supabase E foi editado pelo app DEPOIS que
//       este arquivo foi gerado → mantém a versão do Supabase (a edição
//       manual é mais recente que a planilha, então ela "vence").
//     - Caso contrário → usa a versão do arquivo (a planilha é mais
//       recente, ou o item nunca foi editado manualmente).
//     - Itens que existem SÓ no Supabase (adicionados pelo app, nunca
//       vieram de nenhuma planilha) são mantidos também — nunca são
//       apagados por uma publicação.
//
// Depois da mesclagem, os percentuais de cada nível "resumo" da EAP (fase,
// módulo, macroetapa) e o resumo geral do topo são recalculados a partir
// das atividades-folha, para que tudo continue matematicamente consistente
// mesmo depois da mesclagem — exatamente com a mesma fórmula que o app usa
// ao vivo (peso_rollup quando existir, ideal_fixo preservado quando
// marcado, excluir_do_rollup_pai para rotinas recorrentes).

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

function mergeRitos(fileRitos, dbRitos, fileGeneratedAt) {
  const dbByNome = new Map((dbRitos || []).map((r) => [slug(r.nome), r]));
  const generatedAtMs = fileGeneratedAt ? Date.parse(fileGeneratedAt) : 0;
  const fileNomes = new Set((fileRitos || []).map((r) => slug(r.nome)));

  const merged = (fileRitos || []).map((r) => {
    const dbMatch = dbByNome.get(slug(r.nome));
    if (!dbMatch) return r;

    // Se o rito foi editado pelo app (arrastar horário, formulário) DEPOIS
    // que este arquivo foi gerado, a edição do app vence por completo —
    // igual à regra usada para a EAP. Isso cobre horário, cadência etc.,
    // não só as confirmações de presença.
    if (dbMatch.editado_em) {
      const editadoMs = Date.parse(dbMatch.editado_em);
      if (!isNaN(editadoMs) && editadoMs > generatedAtMs) {
        return dbMatch;
      }
    }

    // Caso contrário, a planilha/arquivo manda na definição do rito, mas as
    // confirmações de presença (que só existem no banco) são sempre
    // preservadas por cima.
    if (Array.isArray(dbMatch.respostas) && dbMatch.respostas.length > 0) {
      return { ...r, respostas: dbMatch.respostas };
    }
    return r;
  });

  // Ritos criados só pelo app (nunca vieram de nenhuma planilha) não são
  // descartados por uma publicação.
  (dbRitos || []).forEach((dbRito) => {
    if (!fileNomes.has(slug(dbRito.nome))) {
      merged.push(dbRito);
    }
  });

  return merged;
}

// Mescla a árvore eap nó a nó: edições manuais mais recentes que a geração
// do arquivo vencem; o resto vem do arquivo; itens só-do-banco são mantidos.
function mergeEap(fileEap, dbEap, fileGeneratedAt) {
  const dbByCode = new Map((dbEap || []).map((n) => [n.eap, n]));
  const fileCodesUsados = new Set();
  const generatedAtMs = fileGeneratedAt ? Date.parse(fileGeneratedAt) : 0;

  const merged = (fileEap || []).map((fileNode) => {
    fileCodesUsados.add(fileNode.eap);
    const dbNode = dbByCode.get(fileNode.eap);
    if (dbNode && dbNode.editado_em) {
      const editadoMs = Date.parse(dbNode.editado_em);
      if (!isNaN(editadoMs) && editadoMs > generatedAtMs) {
        return dbNode; // edição manual é mais recente que a planilha — vence
      }
    }
    return fileNode;
  });

  // Itens que só existem no banco (criados pelo app, nunca vieram de
  // nenhuma planilha) — nunca são descartados por uma publicação.
  (dbEap || []).forEach((dbNode) => {
    if (!fileCodesUsados.has(dbNode.eap)) {
      merged.push(dbNode);
    }
  });

  return merged;
}

// Recalcula os percentuais de cima a baixo → de baixo a cima, com a MESMA
// regra usada pelo app ao vivo (recalcEapRollup), para que o arquivo
// publicado fique consistente mesmo depois da mesclagem.
function recalcRollup(eap, macroList) {
  const byCode = new Map(eap.map((n) => [n.eap, n]));
  const childrenByPai = new Map();
  eap.forEach((n) => {
    if (n.pai) {
      if (!childrenByPai.has(n.pai)) childrenByPai.set(n.pai, []);
      childrenByPai.get(n.pai).push(n);
    }
  });

  const memo = new Map();
  function pctOf(code) {
    if (memo.has(code)) return memo.get(code);
    const node = byCode.get(code);
    if (!node) return { ideal: 0, real: 0 };
    const kids = childrenByPai.get(code) || [];
    let result;
    if (kids.length === 0) {
      result = { ideal: node.pct_ideal || 0, real: node.pct_real || 0 };
    } else {
      const countableKids = kids.filter((k) => !k.excluir_do_rollup_pai);
      const kidsForAvg = countableKids.length ? countableKids : kids;
      let sumIdeal = 0, sumReal = 0, sumPeso = 0;
      kidsForAvg.forEach((k) => {
        const p = pctOf(k.eap);
        const peso = typeof k.peso_rollup === "number" && k.peso_rollup > 0 ? k.peso_rollup : 1;
        sumIdeal += p.ideal * peso;
        sumReal += p.real * peso;
        sumPeso += peso;
      });
      const idealCalculado = sumIdeal / sumPeso;
      const realCalculado = sumReal / sumPeso;
      result = {
        ideal: node.ideal_fixo ? node.pct_ideal || 0 : idealCalculado,
        real: realCalculado,
      };
      node.pct_ideal = result.ideal;
      node.pct_real = result.real;
    }
    memo.set(code, result);
    return result;
  }

  const raizes = eap.filter((n) => !n.pai);
  raizes.forEach((r) => {
    const p = pctOf(r.eap);
    const macroItem = macroList.find((m) => m.codigo === r.eap);
    if (macroItem) {
      macroItem.pct_ideal = p.ideal;
      macroItem.pct_real = p.real;
      if (macroItem.pct_ideal === 0 && macroItem.pct_real === 0) macroItem.situacao = "Futura";
      else if (macroItem.pct_real >= macroItem.pct_ideal) macroItem.situacao = "Verde";
      else macroItem.situacao = "Vermelho";
    }
  });

  const totalPeso = macroList.reduce((s, m) => s + m.peso, 0) || 1;
  const resumoIdeal = macroList.reduce((s, m) => s + m.pct_ideal * m.peso, 0) / totalPeso;
  const resumoReal = macroList.reduce((s, m) => s + m.pct_real * m.peso, 0) / totalPeso;
  return { pct_ideal: resumoIdeal, pct_real: resumoReal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lerEstadoAtual() {
  const resp = await fetch(`${endpoint}?id=eq.1&select=dados,atualizado_em`, { method: "GET", headers });
  if (!resp.ok) {
    console.warn("Não consegui ler o estado atual do Supabase:", resp.status);
    return { dados: null, atualizado_em: null };
  }
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) return { dados: null, atualizado_em: null };
  return { dados: rows[0].dados || null, atualizado_em: rows[0].atualizado_em ?? null };
}

function montarDadosMesclados(dbDados) {
  const eapMesclado = mergeEap(fileDados.eap, dbDados ? dbDados.eap : null, fileDados.generated_at);
  const macroMesclado = (fileDados.macro || []).map((m) => ({ ...m }));
  const resumoRecalculado = recalcRollup(eapMesclado, macroMesclado);

  return {
    ...fileDados,
    eap: eapMesclado,
    macro: macroMesclado,
    resumo: resumoRecalculado,
    ritos: mergeRitos(fileDados.ritos, dbDados ? dbDados.ritos : null, fileDados.generated_at),
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
        `plano de ação, confirmações de reunião e edições manuais recentes na EAP preservados.`
      );
      return;
    }

    if (!atualizadoEmLido) {
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
