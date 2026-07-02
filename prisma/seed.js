const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const roles = ["CANDIDATE", "RECRUITER", "ADMIN"];

  for (const roleName of roles) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
  }

  const candidateRole = await prisma.role.findUnique({
    where: { name: "CANDIDATE" },
  });

  const recruiterRole = await prisma.role.findUnique({
    where: { name: "RECRUITER" },
  });

  const adminRole = await prisma.role.findUnique({
    where: { name: "ADMIN" },
  });

  const candidate = await prisma.user.upsert({
    where: { email: "candidate@test.com" },
    update: {},
    create: {
      email: "candidate@test.com",
      name: "Candidate User",
    },
  });

  const recruiter = await prisma.user.upsert({
    where: { email: "recruiter@test.com" },
    update: {},
    create: {
      email: "recruiter@test.com",
      name: "Recruiter User",
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: "admin@test.com" },
    update: {},
    create: {
      email: "admin@test.com",
      name: "Admin User",
    },
  });

  await prisma.userRole.createMany({
    data: [
      { userId: candidate.id, roleId: candidateRole.id },
      { userId: recruiter.id, roleId: recruiterRole.id },
      { userId: admin.id, roleId: adminRole.id },
    ],
    skipDuplicates: true,
  });

  console.log("Seed completed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
