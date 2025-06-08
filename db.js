import fs from 'fs/promises';

const dbPath = './db.json';

export async function readDB() {
  try {
    const data = await fs.readFile(dbPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { users: {} };
  }
}

export async function writeDB(db) {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
}