import db from './db.js'

await db.read()
console.log(db.data)
