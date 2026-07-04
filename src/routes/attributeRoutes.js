const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const attributes = await prisma.attribute.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        options: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    res.json(attributes);
  } catch (error) {
    console.error("GET /api/attributes error:", error);
    res.status(500).json({ message: "Failed to load attributes" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, category, type, description, options } = req.body;

    if (!name || !category || !type) {
      return res.status(400).json({
        message: "Name, category, and type are required",
      });
    }

    const attribute = await prisma.attribute.create({
      data: {
        name,
        category,
        type,
        description: description || null,
        options: {
          create:
            type === "SELECT" && Array.isArray(options)
              ? options.map((option, index) => ({
                  value: option.value,
                  sortOrder: index + 1,
                }))
              : [],
        },
      },
      include: {
        options: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    res.status(201).json(attribute);
  } catch (error) {
    console.error("POST /api/attributes error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        message: "Attribute with this name already exists",
      });
    }

    res.status(500).json({
      message: "Failed to create attribute",
    });
  }
});

router.delete("/", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "Attribute ids are required",
      });
    }

    const deletedAttributes = await prisma.attribute.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    res.json({
      deletedCount: deletedAttributes.count,
    });
  } catch (error) {
    console.error("DELETE /api/attributes error:", error);

    res.status(500).json({
      message: "Failed to delete attributes",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, category, type, description, version, options } = req.body;

    if (!id) {
      return res.status(400).json({
        message: "Valid attribute id is required",
      });
    }

    if (!name || !category || !type || typeof version !== "number") {
      return res.status(400).json({
        message: "Name, category, type, and version are required",
      });
    }

    const updateResult = await prisma.attribute.updateMany({
      where: {
        id,
        version,
      },
      data: {
        name,
        category,
        type,
        description: description || null,
        version: {
          increment: 1,
        },
      },
    });

    if (updateResult.count === 0) {
      return res.status(409).json({
        message:
          "Attribute was changed by someone else. Please reload and try again.",
      });
    }

    const updatedAttribute = await prisma.attribute.findUnique({
      where: { id },
      include: {
        options: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    res.json(updatedAttribute);
  } catch (error) {
    console.error("PUT /api/attributes/:id error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        message: "Attribute with this name already exists",
      });
    }

    res.status(500).json({
      message: "Failed to update attribute",
    });
  }
});

module.exports = router;
