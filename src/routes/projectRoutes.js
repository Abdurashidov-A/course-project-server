const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

async function getCurrentUserWithRoles(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });
}

function canManageOwnProjects(user) {
  return user?.roles?.some((userRole) => userRole.role?.name === "CANDIDATE");
}

function parseProjectPayload(body) {
  return {
    name: body.name?.trim(),
    description:
      body.description === undefined || body.description === null
        ? null
        : String(body.description),
    periodStart: body.periodStart ? new Date(body.periodStart) : null,
    periodEnd: body.periodEnd ? new Date(body.periodEnd) : null,
    technologyTags: body.technologyTags,
  };
}

function sanitizeTechnologyTags(tags) {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    return null;
  }

  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

router.get("/my", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser || !canManageOwnProjects(currentUser)) {
      return res.status(403).json({
        message: "You do not have access to projects",
      });
    }

    const projects = await prisma.project.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    res.json(projects);
  } catch (error) {
    console.error("GET /api/projects/my error:", error);
    res.status(500).json({
      message: "Failed to load projects",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser || !canManageOwnProjects(currentUser)) {
      return res.status(403).json({
        message: "You do not have access to projects",
      });
    }

    const payload = parseProjectPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({
        message: "Project name is required",
      });
    }

    const technologyTags = sanitizeTechnologyTags(payload.technologyTags);

    if (technologyTags === null) {
      return res.status(400).json({
        message: "technologyTags must be an array of strings",
      });
    }

    const project = await prisma.project.create({
      data: {
        userId,
        name: payload.name,
        description: payload.description,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        technologyTags,
      },
    });

    res.status(201).json(project);
  } catch (error) {
    console.error("POST /api/projects error:", error);
    res.status(500).json({
      message: "Failed to create project",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const id = Number(req.params.id);
    const { version } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser || !canManageOwnProjects(currentUser)) {
      return res.status(403).json({
        message: "You do not have access to projects",
      });
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Valid project id is required",
      });
    }

    if (typeof version !== "number") {
      return res.status(400).json({
        message: "Version is required",
      });
    }

    const payload = parseProjectPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({
        message: "Project name is required",
      });
    }

    const technologyTags = sanitizeTechnologyTags(payload.technologyTags);

    if (technologyTags === null) {
      return res.status(400).json({
        message: "technologyTags must be an array of strings",
      });
    }

    const existingProject = await prisma.project.findUnique({
      where: { id },
    });

    if (!existingProject) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    if (existingProject.userId !== userId) {
      return res.status(403).json({
        message: "You do not have access to this project",
      });
    }

    const updateResult = await prisma.project.updateMany({
      where: {
        id,
        userId,
        version,
      },
      data: {
        name: payload.name,
        description: payload.description,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        technologyTags,
        version: {
          increment: 1,
        },
      },
    });

    if (updateResult.count === 0) {
      return res.status(409).json({
        message: "Project was changed by someone else. Please reload and try again.",
      });
    }

    const updatedProject = await prisma.project.findUnique({
      where: { id },
    });

    res.json(updatedProject);
  } catch (error) {
    console.error("PUT /api/projects/:id error:", error);
    res.status(500).json({
      message: "Failed to update project",
    });
  }
});

router.delete("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const { ids } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser || !canManageOwnProjects(currentUser)) {
      return res.status(403).json({
        message: "You do not have access to projects",
      });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "Project ids are required",
      });
    }

    const numericIds = ids.map(Number);

    if (numericIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({
        message: "All project ids must be valid numbers",
      });
    }

    const deletedProjects = await prisma.project.deleteMany({
      where: {
        id: {
          in: numericIds,
        },
        userId,
      },
    });

    res.json({
      deletedCount: deletedProjects.count,
    });
  } catch (error) {
    console.error("DELETE /api/projects error:", error);
    res.status(500).json({
      message: "Failed to delete projects",
    });
  }
});

module.exports = router;
