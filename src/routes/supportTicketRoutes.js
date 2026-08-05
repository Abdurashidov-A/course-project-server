const express = require("express");
const { SupportTicketError } = require("../services/supportTicketService");

function getSafeErrorMeta(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const code = typeof error?.code === "string" ? error.code : null;

  return {
    name: /^[A-Za-z0-9_]+$/.test(name) ? name : "Error",
    code: code && /^[A-Z0-9_]+$/.test(code) ? code : null,
  };
}

function createSupportTicketRouter(options = {}) {
  const router = express.Router();
  const supportTicketService = options.supportTicketService;

  if (typeof supportTicketService?.submit !== "function") {
    throw new TypeError("supportTicketService with submit() is required");
  }

  router.post("/", async (req, res) => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();

    req.once("aborted", abortRequest);

    try {
      const result = await supportTicketService.submit({
        userId: req.header("x-dev-user-id") || null,
        body: req.body,
        signal: requestController.signal,
      });

      return res.status(201).json(result);
    } catch (error) {
      if (req.aborted || res.headersSent) {
        return;
      }

      if (error instanceof SupportTicketError) {
        if (error.publicCode) {
          return res.status(error.statusCode).json({
            error: {
              code: error.publicCode,
              message: error.message,
            },
          });
        }

        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      console.error(
        "POST /api/support-tickets failed",
        getSafeErrorMeta(error),
      );

      return res.status(500).json({
        message: "Failed to submit support ticket",
      });
    } finally {
      req.removeListener("aborted", abortRequest);
    }
  });

  return router;
}

module.exports = {
  createSupportTicketRouter,
  getSafeErrorMeta,
};
