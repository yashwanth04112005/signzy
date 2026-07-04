import "dotenv/config";
import { app } from "./app.js";
import { connectDB, seedIfEmpty } from "./db.js";


const port = Number(process.env.PORT ?? 3000);

async function start() {
  await connectDB();
  await seedIfEmpty();
  app.listen(port, () => {
    console.log(`Intelligent Vendor Routing Platform running on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});