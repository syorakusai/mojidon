import { getFirebaseContext } from "./firebase-client.js";
import {
  ref, set, get, update, onValue, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import { loadDictionary, normalizeInput, pickRoundTopic, judgeSubmission } from "./dict.js";

const ROUND_DURATION_MS = 30000;
const WIN_SCORE = 10;

let db, uid;
let roomId = null;
let roomRef = null;
let unsubscribeRoom = null;
let myRole = null; // 'host' | 'guest'
let myWords = [];
let timerInterval = null;
let currentRoomData = null;

const el = (id) => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  el(`screen-${name}`).classList.add("active");
}

function setStatus(msg) {
  el("statusLine").textContent = msg;
}

// ---------- 初期化 ----------
async function init() {
  setStatus("辞書を読み込み中…");
  await loadDictionary();
  setStatus("接続中…");
  const ctx = await getFirebaseContext();
  db = ctx.database;
  uid = ctx.user.uid;
  setStatus("");
  showScreen("title");
}

// ---------- ルーム作成/参加 ----------
async function createRoom() {
  const name = el("nameInput").value.trim() || "プレイヤー";
  const newId = Math.random().toString(36).slice(2, 7).toUpperCase();
  const rRef = ref(db, `mojidonRooms/${newId}`);
  const initial = {
    hostUid: uid,
    hostName: name,
    guestUid: null,
    guestName: null,
    status: "waiting",
    createdAt: Date.now(),
    scoreDiff: 0,
    winner: null,
    round: null
  };
  await set(rRef, initial);
  myRole = "host";
  enterRoom(newId, rRef);
}

async function joinRoom() {
  const name = el("nameInput").value.trim() || "プレイヤー";
  const inputId = el("roomIdInput").value.trim().toUpperCase();
  if (!inputId) {
    setStatus("ルームIDを入力してください");
    return;
  }
  const rRef = ref(db, `mojidonRooms/${inputId}`);
  const snap = await get(rRef);
  if (!snap.exists()) {
    setStatus("そのルームは見つかりませんでした");
    return;
  }
  const data = snap.val();
  if (data.status !== "waiting" || data.guestUid) {
    setStatus("このルームには参加できません（満員か開始済みです）");
    return;
  }
  await update(rRef, { guestUid: uid, guestName: name });
  myRole = "guest";
  enterRoom(inputId, rRef);
}

function enterRoom(id, rRef) {
  roomId = id;
  roomRef = rRef;
  showScreen("room");
  el("roomIdLabel").textContent = roomId;
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = onValue(roomRef, (snap) => {
    const data = snap.val();
    if (!data) return;
    currentRoomData = data;
    onRoomUpdate(data);
  });
}

// ---------- ルーム状態の変化に応じた描画/進行 ----------
function onRoomUpdate(data) {
  el("hostNameLabel").textContent = data.hostName || "-";
  el("guestNameLabel").textContent = data.guestName || "(待機中)";

  if (data.status === "waiting") {
    showScreen("room");
    if (myRole === "host" && data.guestUid) {
      // ゲスト参加を検知したらホストが最初のラウンドを開始
      startNewRound(data);
    }
    return;
  }

  if (data.status === "finished") {
    renderFinished(data);
    return;
  }

  if (data.status === "playing" && data.round) {
    if (data.round.phase === "input") {
      renderInputPhase(data);
    } else if (data.round.phase === "result") {
      renderResultPhase(data);
    }
  }
}

// ---------- ラウンド開始(ホストのみ書き込み) ----------
async function startNewRound(data) {
  const topic = pickRoundTopic();
  const nextIndex = data.round ? data.round.index + 1 : 1;
  const round = {
    index: nextIndex,
    char: topic.char,
    position: topic.position,
    phase: "input",
    startAt: Date.now(),
    duration: ROUND_DURATION_MS,
    submissions: {},
    hostJudged: null,
    guestJudged: null,
    hostCount: null,
    guestCount: null,
    diff: null
  };
  await update(roomRef, { status: "playing", round });
}

// ---------- 入力フェーズ ----------
function renderInputPhase(data) {
  showScreen("game");
  myWords = [];
  el("wordList").innerHTML = "";
  el("wordInput").value = "";
  el("wordInput").disabled = false;
  el("addWordBtn").disabled = false;

  el("topicChar").textContent = data.round.char;
  el("topicPosition").textContent = data.round.position;
  el("roundIndexLabel").textContent = data.round.index;
  renderScoreGauge(data.scoreDiff);

  startTimer(data.round.startAt, data.round.duration, () => {
    onInputTimeUp(data);
  });
}

function startTimer(startAt, duration, onDone) {
  if (timerInterval) clearInterval(timerInterval);
  const endAt = startAt + duration;
  let done = false;
  const tick = () => {
    const remain = Math.max(0, endAt - Date.now());
    el("timerLabel").textContent = Math.ceil(remain / 1000);
    if (remain <= 0 && !done) {
      done = true;
      clearInterval(timerInterval);
      onDone();
    }
  };
  tick();
  timerInterval = setInterval(tick, 200);
}

function addWord() {
  const raw = el("wordInput").value;
  if (!raw) return;
  const norm = normalizeInput(raw);
  el("wordInput").value = "";
  if (!norm) return;
  myWords.push(norm);
  const li = document.createElement("li");
  li.textContent = norm;
  el("wordList").appendChild(li);
  el("wordList").scrollTop = el("wordList").scrollHeight;
}

async function onInputTimeUp(data) {
  el("wordInput").disabled = true;
  el("addWordBtn").disabled = true;
  el("timerLabel").textContent = "0";

  // 自分の提出を書き込む
  const myUidPath = `mojidonRooms/${roomId}/round/submissions/${uid}`;
  await set(ref(db, myUidPath), { words: myWords, submittedAt: Date.now() });

  if (myRole === "host") {
    judgeAndAdvance();
  }
}

// ---------- 判定(ホストのみ) ----------
async function judgeAndAdvance() {
  // 両者の提出が揃うまで少し待つ(タイマーのわずかなズレ対策)
  const snap = await waitForBothSubmissions();
  const data = snap;
  const hostUid = data.hostUid;
  const guestUid = data.guestUid;
  const hostWords = data.round.submissions?.[hostUid]?.words || [];
  const guestWords = data.round.submissions?.[guestUid]?.words || [];
  const topic = { char: data.round.char, position: data.round.position };

  const hostResult = judgeSubmission(hostWords, topic);
  const guestResult = judgeSubmission(guestWords, topic);
  const diff = hostResult.validCount - guestResult.validCount;

  const newScoreDiff = (data.scoreDiff || 0) + diff;
  const finished = Math.abs(newScoreDiff) >= WIN_SCORE;

  const updates = {
    "round/phase": "result",
    "round/hostJudged": hostResult.judged,
    "round/guestJudged": guestResult.judged,
    "round/hostCount": hostResult.validCount,
    "round/guestCount": guestResult.validCount,
    "round/diff": diff,
    scoreDiff: newScoreDiff
  };
  if (finished) {
    updates.status = "finished";
    updates.winner = newScoreDiff > 0 ? "host" : "guest";
  }
  await update(roomRef, updates);
}

function waitForBothSubmissions() {
  return new Promise((resolve) => {
    const check = async () => {
      const snap = await get(roomRef);
      const data = snap.val();
      const hostSub = data.round.submissions?.[data.hostUid];
      const guestSub = data.round.submissions?.[data.guestUid];
      if (hostSub && guestSub) {
        resolve(data);
      } else {
        setTimeout(check, 400);
      }
    };
    check();
  });
}

// ---------- 結果フェーズ ----------
let resultRenderedFor = null;

function renderResultPhase(data) {
  showScreen("game");
  if (timerInterval) clearInterval(timerInterval);
  el("timerLabel").textContent = "-";

  const key = `${data.round.index}`;
  if (resultRenderedFor === key) return; // 二重描画防止
  resultRenderedFor = key;

  const isHost = myRole === "host";
  const myJudged = isHost ? data.round.hostJudged : data.round.guestJudged;
  const oppJudged = isHost ? data.round.guestJudged : data.round.hostJudged;
  const myCount = isHost ? data.round.hostCount : data.round.guestCount;
  const oppCount = isHost ? data.round.guestCount : data.round.hostCount;

  el("resultArea").classList.remove("hidden");
  el("inputArea").classList.add("hidden");

  const list = el("resultList");
  list.innerHTML = "";
  const maxLen = Math.max(myJudged.length, oppJudged.length);
  for (let i = 0; i < maxLen; i++) {
    const mine = myJudged[i];
    const opp = oppJudged[i];
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <span class="result-word ${mine ? (mine.valid ? "ok" : "ng") : "empty"}">${mine ? mine.word : ""}</span>
      <span class="vs">vs</span>
      <span class="result-word ${opp ? (opp.valid ? "ok" : "ng") : "empty"}">${opp ? opp.word : ""}</span>
    `;
    list.appendChild(row);
  }

  el("myCountLabel").textContent = myCount;
  el("oppCountLabel").textContent = oppCount;

  const diffForMe = isHost ? data.round.diff : -data.round.diff;
  el("roundDiffLabel").textContent =
    diffForMe > 0 ? `+${diffForMe} 押した！` : diffForMe < 0 ? `${diffForMe} 押された…` : "引き分け";

  renderScoreGauge(data.scoreDiff);

  el("nextRoundBtn").classList.toggle("hidden", myRole !== "host");
  el("waitingHostLabel").classList.toggle("hidden", myRole === "host");
}

async function nextRound() {
  const snap = await get(roomRef);
  const data = snap.val();
  resultRenderedFor = null;
  el("resultArea").classList.add("hidden");
  el("inputArea").classList.remove("hidden");
  startNewRound(data);
}

// ---------- 終了画面 ----------
function renderFinished(data) {
  showScreen("finished");
  const isHost = myRole === "host";
  const iWon = (data.winner === "host" && isHost) || (data.winner === "guest" && !isHost);
  el("finishedTitle").textContent = iWon ? "勝利！" : "敗北…";
  el("finishedSub").textContent = `最終スコア差: ${Math.abs(data.scoreDiff)}`;
  el("rematchBtn").classList.toggle("hidden", myRole !== "host");
  el("rematchWaitLabel").classList.toggle("hidden", myRole === "host");
}

async function rematch() {
  await update(roomRef, {
    status: "waiting",
    scoreDiff: 0,
    winner: null,
    round: null
  });
  resultRenderedFor = null;
  showScreen("room");
}

function renderScoreGauge(scoreDiff) {
  const pct = 50 + (scoreDiff / WIN_SCORE) * 50;
  const clamped = Math.max(0, Math.min(100, pct));
  el("gaugeFill").style.width = `${clamped}%`;
  el("gaugeLabel").textContent = `${scoreDiff > 0 ? "ホスト" : scoreDiff < 0 ? "ゲスト" : "互角"} ${scoreDiff !== 0 ? Math.abs(scoreDiff) : ""}`;
}

// ---------- イベント登録 ----------
el("createRoomBtn").addEventListener("click", createRoom);
el("joinRoomBtn").addEventListener("click", joinRoom);
el("addWordBtn").addEventListener("click", addWord);
el("wordInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addWord();
});
el("nextRoundBtn").addEventListener("click", nextRound);
el("rematchBtn").addEventListener("click", rematch);
el("copyRoomIdBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomId);
    setStatus("ルームIDをコピーしました");
  } catch {
    setStatus("コピーに失敗しました");
  }
});

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));
}
