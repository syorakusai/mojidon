import { firebaseConfig } from "./firebase-config.js";
import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

function waitForRestoredUser(auth) {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    }, reject);
  });
}

let contextPromise = null;

export function getFirebaseContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const restoredUser = await waitForRestoredUser(auth);
      const user = restoredUser || (await signInAnonymously(auth)).user;
      if (!user?.uid) throw new Error("匿名認証後のUIDを取得できませんでした。");
      return { app, auth, database: getDatabase(app), user };
    })();
  }
  return contextPromise;
}
