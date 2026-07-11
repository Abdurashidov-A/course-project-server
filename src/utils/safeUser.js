function serializeSafeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    roles: (user.roles || []).map((userRole) =>
      typeof userRole === "string" ? userRole : userRole.role?.name,
    ).filter(Boolean),
  };
}

module.exports = {
  serializeSafeUser,
};
