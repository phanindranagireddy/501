const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const pool = require("./database");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
  session({
    secret: "secret",
    resave: false,
    saveUninitialized: true,
  })
);

app.set("view engine", "ejs");

function isAuthenticated(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect("/login");
  }
}

async function fetchSports() {
  try {
    const result = await pool.query("SELECT * FROM sports");
    return result.rows;
  } catch (err) {
    console.error("Error fetching sports:", err);
    throw err;
  }
}

function formatPostgreSQLDate(date) {
  const pad = (num) => (num < 10 ? `0${num}` : num); 

  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1); 
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
}

async function fetchJoinedSessionsForPlayer(playerId) {
  const query = `
    SELECT sessions.*, sports.name AS sport_name
    FROM sessions
    JOIN sports ON sessions.sport_id = sports.id
    JOIN session_players ON sessions.id = session_players.session_id
    WHERE session_players.player_id = $1
  `;
  const values = [playerId];

  try {
    const result = await pool.query(query, values);
    return result.rows;
  } catch (err) {
    console.error('Error fetching joined sessions for player:', err);
    throw err;
  }
}


app.get("/", (req, res) => {
  res.render("dashboard");
});

app.get("/dashboard", isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = userResult.rows[0]; 
    const sportsResult = await fetchSports();
    const sports = sportsResult;

    const sessionsResult = await pool.query(`
      SELECT sessions.*, sports.name AS sport_name
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
    `);
    const sessions = sessionsResult.rows;

    res.render("dashboard", { user, sports, sessions });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [
    email,
  ]);
  if (result.rows.length > 0) {
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = user;
      return res.redirect(
        user.role === "admin" ? "/admin-dashboard" : "/player-dashboard"
      );
    }
  }
  res.redirect("/login");
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", async (req, res) => {
  const { username, email, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)",
    [username, email, hashedPassword, role]
  );
  res.redirect("/login");
});

app.get("/admin-dashboard", isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = userResult.rows[0]; 

    const sportsResult = await fetchSports();
    const sports = sportsResult;

    const sessionsResult = await pool.query(`
      SELECT sessions.*, sports.name AS sport_name
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
    `);
    const sessions = sessionsResult.rows;

    res.render("admin-dashboard", { user, sports, sessions });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal Server Error");
  }
});


async function fetchAvailableSessionsForPlayer(playerId) {
  try {
      const query = `
          SELECT 
              s.id AS session_id,
              s.date,
              s.venue,
              sp.name AS sport_name,
              u.username AS creator_name
          FROM 
              sessions s
          JOIN 
              sports sp ON s.sport_id = sp.id
          JOIN 
              users u ON s.creator_id = u.id
          WHERE 
              s.date >= CURRENT_DATE
              AND s.creator_id != $1
              AND s.id NOT IN (
                  SELECT session_id FROM session_players WHERE player_id = $1
              );
      `;
      
      const { rows } = await pool.query(query, [playerId]);
      return rows;
  } catch (error) {
      throw error;
  }
}


app.get("/player-dashboard", isAuthenticated, async (req, res) => {
  try {
    const playerId = req.session.user.id;
    const availableSessions = await fetchAvailableSessionsForPlayer(playerId);

    const joinedSessions = await fetchJoinedSessionsForPlayer(playerId);

    const user = req.session.user;

    res.render("player-dashboard", { user, availableSessions, joinedSessions });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/create-sport", isAuthenticated, async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query("INSERT INTO sports (name) VALUES ($1)", [name]);
    res.redirect("/admin-dashboard");
  } catch (err) {
    console.error("Error creating sport:", err);
    res.redirect("/admin-dashboard"); 
  }
});
app.post("/delete-sport/:id", isAuthenticated, async (req, res) => {
  const sportId = req.params.id;
  try {
    const sessionsResult = await pool.query("SELECT * FROM sessions WHERE sport_id = $1", [sportId]);
    if (sessionsResult.rows.length > 0) {
      return res.status(400).send("Cannot delete sport with active sessions.");
    }

    await pool.query("DELETE FROM sports WHERE id = $1", [sportId]);
    
    res.redirect("/admin-dashboard");
  } catch (err) {
    console.error("Error deleting sport:", err);
    res.status(500).send("Failed to delete sport.");
  }
});

app.post("/create-session", isAuthenticated, async (req, res) => {
  const { sport_id, date, venue } = req.body;

  try {
    const sportId = parseInt(sport_id, 10);
    const creatorId = req.session.user.id;

    const query = `
      INSERT INTO sessions (sport_id, creator_id, date, venue)
      VALUES ($1, $2, $3, $4)
    `;
    const values = [sportId, creatorId, date, venue];

    await pool.query(query, values);

    res.redirect("/admin-dashboard");
  } catch (err) {
    console.error("Error creating session:", err);
    res.redirect("/admin-dashboard");
  }
});

app.post('/edit-session/:id', isAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const { sport_id, date, venue } = req.body;
  const sportId = parseInt(sport_id, 10);
  const creatorId = req.session.u.id;

  try {
    const session = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND creator_id = $2',
      [sessionId, creatorId]
    );

    if (session.rows.length === 0) {
      return res.status(404).send('Session not found or you do not have permission to edit it.');
    }

    const updateQuery = `
      UPDATE sessions
      SET sport_id = $1, date = $2, venue = $3
      WHERE id = $4
    `;
    const updateValues = [sportId, date, venue, sessionId];

    await pool.query(updateQuery, updateValues);

    res.redirect('/admin-dashboard');
  } catch (error) {
    console.error('Error editing session:', error);
    res.redirect('/admin-dashboard');
  }
});



app.post('/delete-session/:id', isAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const userId = req.session.user.id; 

  try {
    const session = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND creator_id = $2',
      [sessionId, userId]
    );

    if (session.rows.length === 0) {
      return res.status(404).send('Session not found or you do not have permission to delete it.');
    }

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    res.redirect('/admin-dashboard');
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/join-session/:session_id', isAuthenticated, async (req, res) => {
  const sessionId = req.params.session_id;
  const playerId = req.session.user.id;

  try {
    await pool.query(
      'INSERT INTO session_players (session_id, player_id) VALUES ($1, $2)',
      [sessionId, playerId]
    );

    const joinedSessions = await fetchJoinedSessionsForPlayer(playerId);
    const availableSessions = await fetchAvailableSessionsForPlayer(playerId);

    res.render('player-dashboard', {
      user: req.session.user,
      availableSessions: availableSessions,
      joinedSessions: joinedSessions
    });
  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).send('Internal Server Error');
  }
});


app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.get("/reports", isAuthenticated, async (req, res) => {
  try {
    const sessions = await pool.query(`
      SELECT sessions.*, sports.name AS sport_name
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
    `);
    const popularity = await pool.query(`
      SELECT sports.name, COUNT(sessions.id) AS count
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
      GROUP BY sports.name
    `);

    res.render("reports", {
      sessions: sessions.rows,
      popularity: popularity.rows,
    });
  } catch (err) {
    console.error("Error fetching reports:", err);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
