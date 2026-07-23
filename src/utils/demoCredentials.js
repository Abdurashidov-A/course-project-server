const NAMED_DEMO_CREDENTIALS = [
  {
    login: "AlexCandidate",
    password: "alex123",
    email: "alex.candidate@test.com",
    name: "Alex Candidate",
    role: "CANDIDATE",
  },
  {
    login: "MaxCandidate",
    password: "max123",
    email: "max.candidate@test.com",
    name: "Max Candidate",
    role: "CANDIDATE",
  },
  {
    login: "JohnRecruiter",
    password: "john123",
    email: "john.recruiter@test.com",
    name: "John Recruiter",
    role: "RECRUITER",
  },
  {
    login: "SaraRecruiter",
    password: "sara123",
    email: "sara.recruiter@test.com",
    name: "Sara Recruiter",
    role: "RECRUITER",
  },
  {
    login: "MainAdmin",
    password: "admin123",
    email: "main.admin@test.com",
    name: "Main Admin",
    role: "ADMIN",
  },
];

function findDemoCredential(login, password) {
  if (typeof login !== "string" || typeof password !== "string") {
    return null;
  }

  const normalizedLogin = login.trim();
  const credential = NAMED_DEMO_CREDENTIALS.find(
    (item) => item.login === normalizedLogin && item.password === password,
  );

  return credential ? { email: credential.email } : null;
}

function getNamedDemoAccounts() {
  return NAMED_DEMO_CREDENTIALS.map(({ email, name, role }) => ({
    email,
    name,
    role,
  }));
}

module.exports = {
  findDemoCredential,
  getNamedDemoAccounts,
};
