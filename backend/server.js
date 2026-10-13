const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("ScopeDesk backend is running!");
});

app.listen(PORT, () => {
  console.log(`ScopeDesk backend running at http://localhost:${PORT}`);
});