// Team assignments for the sales dashboard
// Names must match the salesperson column in moxy_deals exactly

export const TEAMS: Record<string, string[]> = {
  "Unassigned": [
    // All active salespersons — organize into teams as needed
    "Malik Cameron", "Brendon Witt", "Jovan Moore", "Carly Schwerdt",
    "Trevor Chatman", "David Andrews", "Daniel Andrews", "Denise Moore",
    "Brian Thompson", "Nathan Hennessey", "Shakar Butler", "Tyler Jones",
    "Jermail Mack", "Dillon Drennen", "Hershell Ivory", "Kentrell Simmons",
    "Sara Klein", "Bryan Barraza", "Sean Leonard", "Gil Marquez",
    "Melvin Moore", "Jason Ulrich", "Emma Chargbach", "Antoine Moorehead",
    "Madison Deprow", "Quinton Lovett", "Olivia Thiemann", "Michael Flieger",
    "Davontae Henry", "Robert Ball", "Roderick Baltimore", "Michael Melton",
    "Dominic Madison", "Kendall Keiser", "Noah Bon Cheque", "Devin Shirley",
    "Renea Plummer", "Paul Mcguire", "Thomas Gatewood", "Anthoney Ellis",
    "Peter Willenborg", "Cordell Francis", "Steven Garner", "Jake Kiethline",
    "Steven Lachino", "Mark Colin", "Farrah Zenk", "Jake Dorris",
    "Peyton Eyster", "Jim Collins", "Josh Aguirre", "Kodey Skaggs",
    "Santiago Cortez", "Jim Schieferle", "Joe Chavez", "Marquez Ellison",
    "Sterling Butler", "James Crews", "Kayley Jackson", "Adam Wootten",
    "Derrick Mitchell",
  ],
};

// Excluded from the sales dashboard (test accounts, system users)
export const EXCLUDED_SALESPERSONS = ["Jeremy Fishbein", "GPG X1 Transfer"];

export function getTeamForAgent(name: string): string | null {
  for (const [team, members] of Object.entries(TEAMS)) {
    if (members.some((m) => m.toLowerCase() === name.toLowerCase())) return team;
  }
  return null;
}

export function isExcludedSalesperson(name: string): boolean {
  return EXCLUDED_SALESPERSONS.some(
    (e) => e.toLowerCase() === name.toLowerCase()
  );
}
