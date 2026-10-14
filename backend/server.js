const express = require("express");
const authRouter = require("./auth");

const app = express();
const PORT = 3000;

app.use(express.json());

//Basic backend health check
app.get("/", (req, res) => {
  res.send("ScopeDesk backend is running!");
});

//Authentication API routes
app.use("/api/auth",authRouter);

app.listen(PORT, () => {
  console.log(`ScopeDesk backend running at http://localhost:${PORT}`);
});