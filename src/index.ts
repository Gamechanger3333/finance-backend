import "dotenv/config";
import app from "./app.js";
import { logger } from "./lib/logger.js";

const port = Number(process.env.PORT || 3001);

app.listen(port, () => {
  logger.info({ port }, "FinFlow backend listening");
});
