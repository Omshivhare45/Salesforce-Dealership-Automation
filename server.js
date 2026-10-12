
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// Demo storage only: data disappears when server restarts.
const bookings = [];

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Dealership Test Drive Booking API",
    version: "1.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy"
  });
});

// Create booking
app.post("/api/bookings", (req, res) => {
  const { name, email, phone, brand, model, date, time, notes } = req.body;

  const required = { name, email, phone, brand, model, date, time };
  const missing = Object.keys(required).filter(
    key => typeof required[key] !== "string" || !required[key].trim()
  );

  if (missing.length) {
    return res.status(400).json({
      success: false,
      message: "Required fields are missing",
      fields: missing
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address"
    });
  }

  if (!/^[0-9+\-\s()]{10,18}$/.test(phone)) {
    return res.status(400).json({
      success: false,
      message: "Invalid phone number"
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false,
      message: "Date must use YYYY-MM-DD format"
    });
  }

  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date ||
    date < new Date().toISOString().slice(0, 10)
  ) {
    return res.status(400).json({
      success: false,
      message: "Please choose a valid current or future date"
    });
  }

  const booking = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    brand: brand.trim(),
    model: model.trim(),
    date,
    time: time.trim(),
    notes: typeof notes === "string" ? notes.trim() : "",
    status: "Pending Confirmation",
    createdAt: new Date().toISOString()
  };

  bookings.push(booking);

  return res.status(201).json({
    success: true,
    message: "Booking request created",
    booking
  });
});

// Retrieve demo bookings
app.get("/api/bookings", (req, res) => {
  res.json({
    success: true,
    count: bookings.length,
    bookings
  });
});

// Handle invalid JSON and other errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body"
    });
  }

  console.error(err);
  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
