#!/usr/bin/env node
// OWNER_PASSWORD_HASH 生成ヘルパー。
// 使い方:
//   node scripts/hash-password.mjs                 # 対話入力 (入力は表示されない)
//   node scripts/hash-password.mjs 'my-password'   # 引数で指定 (シェル履歴に残る点に注意)
//   echo -n 'my-password' | node scripts/hash-password.mjs   # 標準入力
// 出力形式: scrypt$<salt_hex>$<hash_hex> (src/crypto.ts と同一パラメータ: keylen=64, 既定の N/r/p)
import { randomBytes, scrypt } from "node:crypto";

const KEYLEN = 64;

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("中断しました"));
        }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function getPassword() {
  if (process.argv[2] !== undefined) return process.argv[2];
  if (!process.stdin.isTTY) return readStdin();
  const a = await readHidden("パスワード: ");
  const b = await readHidden("確認のためもう一度: ");
  if (a !== b) throw new Error("パスワードが一致しません");
  return a;
}

try {
  const password = await getPassword();
  if (!password) throw new Error("パスワードが空です");
  const salt = randomBytes(16);
  const key = await new Promise((res, rej) =>
    scrypt(password, salt, KEYLEN, (e, k) => (e ? rej(e) : res(k))),
  );
  console.log(`scrypt$${salt.toString("hex")}$${key.toString("hex")}`);
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
}
