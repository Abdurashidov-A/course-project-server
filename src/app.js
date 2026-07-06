const express = require("express");
const cors = require("cors");
const prisma = require("./lib/prisma");
const attributeRoutes = require("./routes/attributeRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/attributes", attributeRoutes);
const positionRoutes = require("./routes/positionRoutes");

app.use("/api/positions", positionRoutes);

app.get("/", (req, res) => {
  res.send("CV Management API is running");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "cv-management-api",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/dev/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    const formattedUsers = users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      version: user.version,
      roles: user.roles.map((userRole) => userRole.role.name),
    }));

    res.json(formattedUsers);
  } catch (error) {
    console.log("Failed to fetch users", error);

    res.status(500).json({
      message: "Failed to fetch users",
    });
  }
});

app.post("/api/auth/dev-login", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Email is required",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (user.status === "BLOCKED") {
      return res.status(403).json({
        message: "User is blocked",
      });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        version: user.version,
        roles: user.roles.map((userRole) => userRole.role.name),
      },
    });
  } catch (error) {
    console.error("Dev login failed:", error);

    res.status(500).json({
      message: "Dev login failed",
    });
  }
});

module.exports = app;
