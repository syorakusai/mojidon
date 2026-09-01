// 辞書の読み込みと、かな正規化・判定まわりのユーティリティ

let dictWordsPromise = null;
let dictSet = null;

export function loadDictionary() {
  if (!dictWordsPromise) {
    dictWordsPromise = fetch("./data/words.json", { cache: "force-cache" })
      .then((res) => res.json())
      .then((words) => {
        dictSet = new Set(words);
        return words;
      });
  }
  return dictWordsPromise;
}

export function getDictArray() {
  // pickRound用に配列も欲しいので、読み込み完了後に呼ぶこと
  return dictSet ? Array.from(dictSet) : [];
}

// カタカナ→ひらがな変換
export function toHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

// 入力の正規化: 前後空白除去、カタカナ→ひらがな、全角/半角スペース除去
export function normalizeInput(raw) {
  return toHiragana(raw.trim().replace(/[\s\u3000]/g, ""));
}

// ひらがなのみで構成されているか
export function isHiraganaOnly(str) {
  return /^[\u3041-\u3096\u30fc]+$/.test(str);
}

// お題(文字, 位置)をランダムに1つ選ぶ。辞書内の実在語から選ぶので必ず正解が存在する
export function pickRoundTopic() {
  const words = getDictArray();
  if (words.length === 0) return null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const w = words[Math.floor(Math.random() * words.length)];
    if (w.length < 2) continue; // 短すぎる語は避ける
    const position = 1 + Math.floor(Math.random() * w.length);
    const char = w[position - 1];
    return { char, position };
  }
  // フォールバック(理論上ほぼ到達しない)
  const w = words[0];
  return { char: w[0], position: 1 };
}

// 1人分の提出リストを判定する
// words: string[] (正規化済みひらがな, 入力順)
// topic: { char, position }
// 戻り値: { judged: [{word, valid, reason}], validCount }
export function judgeSubmission(words, topic) {
  const seen = new Set();
  const judged = [];
  let validCount = 0;

  for (const word of words) {
    if (!word) continue;
    if (seen.has(word)) {
      judged.push({ word, valid: false, reason: "duplicate" });
      continue;
    }
    seen.add(word);

    if (!isHiraganaOnly(word)) {
      judged.push({ word, valid: false, reason: "invalid_chars" });
      continue;
    }
    if (word.length < topic.position) {
      judged.push({ word, valid: false, reason: "too_short" });
      continue;
    }
    if (word[topic.position - 1] !== topic.char) {
      judged.push({ word, valid: false, reason: "wrong_position" });
      continue;
    }
    if (!dictSet.has(word)) {
      judged.push({ word, valid: false, reason: "not_in_dict" });
      continue;
    }
    judged.push({ word, valid: true, reason: null });
    validCount++;
  }

  return { judged, validCount };
}
