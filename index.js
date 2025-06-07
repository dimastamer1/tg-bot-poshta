// index.js
import { loadDB, saveDB } from './db.js'

const db = await loadDB()

db.users.push({ id: Date.now(), name: 'new user' })

await saveDB(db)

console.log('Users:', db.users)
