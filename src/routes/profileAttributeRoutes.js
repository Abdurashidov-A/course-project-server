const express = require("express");
const prisma = require("../lib/prisma");
const router = express.Router();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}
router.get("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const values = await prisma.profileAttributeValue.findMany({
      where: {
        userId: userId,
      },
      include: {
        attribute: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(values);
  } catch (error) {
    console.error("Get profile attribute values error:", error);
    res.status(500).json({ message: "Failed to get profile attribute values" });
  }
});

router.put("/:attributeId", async (req, res) => {
  try {
    const attributeId = Number(req.params.attributeId);
    const { value, version } = req.body;

    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(attributeId)) {
      return res.status(400).json({ message: "Invalid attribute id" });
    }

    const attribute = await prisma.attribute.findUnique({
      where: { id: attributeId },
    });

    if (!attribute) {
      return res.status(404).json({ message: "Attribute not found" });
    }

    const existingValue = await prisma.profileAttributeValue.findUnique({
      where: {
        userId_attributeId: {
          userId: userId,
          attributeId,
        },
      },
    });

    const data = {
      userId: userId,
      attributeId,

      stringValue: null,
      textValue: null,
      numericValue: null,
      booleanValue: null,
      dateValue: null,
      periodStart: null,
      periodEnd: null,
      imageUrl: null,
    };

    if (attribute.type === "STRING") {
      data.stringValue =
        value === undefined || value === null ? "" : String(value);
    }

    if (attribute.type === "TEXT") {
      data.textValue =
        value === undefined || value === null ? "" : String(value);
    }

    if (attribute.type === "NUMERIC") {
      data.numericValue =
        value === "" || value === null || value === undefined
          ? null
          : Number(value);
    }

    if (attribute.type === "BOOLEAN") {
      data.booleanValue = Boolean(value);
    }

    if (attribute.type === "DATE") {
      data.dateValue = value ? new Date(value) : null;
    }

    if (attribute.type === "IMAGE") {
      data.imageUrl =
        value === undefined || value === null ? "" : String(value);
    }

    if (attribute.type === "SELECT") {
      data.stringValue =
        value === undefined || value === null ? "" : String(value);
    }

    if (attribute.type === "PERIOD") {
      data.periodStart = value?.periodStart
        ? new Date(value.periodStart)
        : null;
      data.periodEnd = value?.periodEnd ? new Date(value.periodEnd) : null;
    }

    if (!existingValue) {
      const createdValue = await prisma.profileAttributeValue.create({
        data,
        include: { attribute: true },
      });

      return res.status(201).json(createdValue);
    }

    if (existingValue.version !== version) {
      return res.status(409).json({
        message: "Profile attribute value was changed by someone else",
        currentValue: existingValue,
      });
    }

    const updatedValue = await prisma.profileAttributeValue.update({
      where: { id: existingValue.id },
      data: {
        ...data,
        version: {
          increment: 1,
        },
      },
      include: { attribute: true },
    });

    res.json(updatedValue);
  } catch (error) {
    console.error("Save profile attribute value error:", error);
    res.status(500).json({ message: "Failed to save profile attribute value" });
  }
});

router.delete("/", async (req, res) => {
  try {
    const { ids } = req.body;

    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array" });
    }

    const numericIds = ids.map(Number);

    if (numericIds.some((id) => !Number.isInteger(id))) {
      return res.status(400).json({ message: "All ids must be numbers" });
    }

    const deletedValues = await prisma.profileAttributeValue.deleteMany({
      where: {
        id: {
          in: numericIds,
        },
        userId: userId,
      },
    });

    res.json({
      message: "Profile attribute values deleted",
      count: deletedValues.count,
    });
  } catch (error) {
    console.error("Delete profile attribute values error:", error);
    res
      .status(500)
      .json({ message: "Failed to delete profile attribute values" });
  }
});
module.exports = router;
