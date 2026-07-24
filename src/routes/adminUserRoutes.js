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

function getRoleNames(user) {
  return user?.roles?.map((userRole) => userRole.role?.name) || [];
}

function isAdminUser(user) {
  return getRoleNames(user).includes("ADMIN");
}

function getPrimaryRole(user) {
  const roleNames = getRoleNames(user);

  if (roleNames.includes("ADMIN")) {
    return "ADMIN";
  }

  if (roleNames.includes("RECRUITER")) {
    return "RECRUITER";
  }

  if (roleNames.includes("CANDIDATE")) {
    return "CANDIDATE";
  }

  return null;
}

function serializeAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: getPrimaryRole(user),
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: user.version,
  };
}

async function requireAdmin(req, res, forbiddenMessage = "Access denied") {
  const userId = getDevUserId(req);

  if (!userId) {
    res.status(401).json({
      message: "Dev user id header is required",
    });
    return null;
  }

  const currentUser = await getCurrentUserWithRoles(userId);

  if (!currentUser) {
    res.status(401).json({
      message: "Current user not found",
    });
    return null;
  }

  if (!isAdminUser(currentUser)) {
    res.status(403).json({
      message: forbiddenMessage,
    });
    return null;
  }

  return currentUser;
}

router.get("/", async (req, res) => {
  try {
    const currentUser = await requireAdmin(req, res);

    if (!currentUser) {
      return;
    }

    const rawPage = Number(req.query.page);
    const rawPageSize = Number(req.query.pageSize);
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const pageSize =
      Number.isInteger(rawPageSize) && rawPageSize > 0
        ? Math.min(rawPageSize, 100)
        : 20;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const role =
      typeof req.query.role === "string" ? req.query.role.trim() : "";
    const status =
      typeof req.query.status === "string" ? req.query.status.trim() : "";

    const where = {
      ...(q
        ? {
            OR: [
              {
                name: {
                  contains: q,
                  mode: "insensitive",
                },
              },
              {
                email: {
                  contains: q,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
      ...(status
        ? {
            status,
          }
        : {}),
      ...(role
        ? {
            roles: {
              some: {
                role: {
                  name: role,
                },
              },
            },
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
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
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      items: items.map(serializeAdminUser),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("GET /api/admin/users error:", error);
    res.status(500).json({
      message: "Failed to load users",
    });
  }
});

router.delete("/", async (req, res) => {
  try {
    const currentUser = await requireAdmin(
      req,
      res,
      "Only admins can delete users",
    );

    if (!currentUser) {
      return;
    }

    const rawIds = req.body?.ids;

    if (!Array.isArray(rawIds)) {
      return res.status(400).json({
        message: "User ids must be an array",
      });
    }

    if (rawIds.length === 0) {
      return res.status(400).json({
        message: "At least one user id is required",
      });
    }

    if (rawIds.some((userId) => typeof userId !== "string" || !userId.trim())) {
      return res.status(400).json({
        message: "All user ids must be non-empty strings",
      });
    }

    const userIds = [...new Set(rawIds.map((userId) => userId.trim()))];
    const deletedCount = await prisma.$transaction(async (tx) => {
      const existingUsers = await tx.user.findMany({
        where: {
          id: {
            in: userIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingUsers.length !== userIds.length) {
        return null;
      }

      const ownedCvs = await tx.cv.findMany({
        where: {
          userId: {
            in: userIds,
          },
        },
        select: {
          id: true,
        },
      });
      const ownedCvIds = ownedCvs.map((cv) => cv.id);
      const cvLikeFilters = [
        {
          userId: {
            in: userIds,
          },
        },
      ];

      if (ownedCvIds.length > 0) {
        cvLikeFilters.push({
          cvId: {
            in: ownedCvIds,
          },
        });
      }

      await tx.cvLike.deleteMany({
        where: {
          OR: cvLikeFilters,
        },
      });
      await tx.positionDiscussionPost.deleteMany({
        where: {
          authorId: {
            in: userIds,
          },
        },
      });
      await tx.oAuthAccount.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
        },
      });
      await tx.profileAttributeValue.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
        },
      });
      await tx.project.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
        },
      });
      await tx.cv.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
        },
      });
      await tx.userRole.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
        },
      });

      const deletedUsers = await tx.user.deleteMany({
        where: {
          id: {
            in: userIds,
          },
        },
      });

      return deletedUsers.count;
    });

    if (deletedCount === null) {
      return res.status(404).json({
        message: "One or more users were not found",
      });
    }

    res.json({
      deletedCount,
      deletedCurrentUser: userIds.includes(currentUser.id),
    });
  } catch (error) {
    console.error("DELETE /api/admin/users error:", error);
    res.status(500).json({
      message: "Failed to delete users",
    });
  }
});

router.patch("/:id/role", async (req, res) => {
  try {
    const currentUser = await requireAdmin(req, res);

    if (!currentUser) {
      return;
    }

    const targetUserId = req.params.id;
    const { role, version } = req.body || {};

    if (!["CANDIDATE", "RECRUITER", "ADMIN"].includes(role)) {
      return res.status(400).json({
        message: "Valid role is required",
      });
    }

    if (typeof version !== "number") {
      return res.status(400).json({
        message: "Version is required",
      });
    }

    if (currentUser.id === targetUserId && role !== "ADMIN") {
      return res.status(400).json({
        message: "You cannot change your own admin role",
      });
    }

    const roleRecord = await prisma.role.findUnique({
      where: {
        name: role,
      },
    });

    if (!roleRecord) {
      return res.status(400).json({
        message: "Role not found",
      });
    }

    const updatedUser = await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: {
          id: targetUserId,
        },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });

      if (!existingUser) {
        return null;
      }

      const updated = await tx.user.updateMany({
        where: {
          id: targetUserId,
          version,
        },
        data: {
          version: {
            increment: 1,
          },
        },
      });

      if (updated.count === 0) {
        return false;
      }

      await tx.userRole.deleteMany({
        where: {
          userId: targetUserId,
        },
      });

      await tx.userRole.create({
        data: {
          userId: targetUserId,
          roleId: roleRecord.id,
        },
      });

      return tx.user.findUnique({
        where: {
          id: targetUserId,
        },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    if (updatedUser === null) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (updatedUser === false) {
      return res.status(409).json({
        message: "User was changed elsewhere. Please reload and try again.",
      });
    }

    res.json(serializeAdminUser(updatedUser));
  } catch (error) {
    console.error("PATCH /api/admin/users/:id/role error:", error);
    res.status(500).json({
      message: "Failed to update user role",
    });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const currentUser = await requireAdmin(req, res);

    if (!currentUser) {
      return;
    }

    const targetUserId = req.params.id;
    const { status, version } = req.body || {};

    if (!["ACTIVE", "BLOCKED"].includes(status)) {
      return res.status(400).json({
        message: "Valid status is required",
      });
    }

    if (typeof version !== "number") {
      return res.status(400).json({
        message: "Version is required",
      });
    }

    if (currentUser.id === targetUserId && status !== currentUser.status) {
      return res.status(400).json({
        message: "You cannot change your own status",
      });
    }

    const updatedUser = await prisma.user.updateMany({
      where: {
        id: targetUserId,
        version,
      },
      data: {
        status,
        version: {
          increment: 1,
        },
      },
    });

    if (updatedUser.count === 0) {
      const existingUser = await prisma.user.findUnique({
        where: {
          id: targetUserId,
        },
      });

      if (!existingUser) {
        return res.status(404).json({
          message: "User not found",
        });
      }

      return res.status(409).json({
        message: "User was changed elsewhere. Please reload and try again.",
      });
    }

    const resultUser = await prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    res.json(serializeAdminUser(resultUser));
  } catch (error) {
    console.error("PATCH /api/admin/users/:id/status error:", error);
    res.status(500).json({
      message: "Failed to update user status",
    });
  }
});

module.exports = router;
