const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const http = require('http'); // For Socket.IO
const { Server } = require('socket.io'); // For Socket.IO
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");

const TransactionsSchema = require('./models/TransactionsSchema');
const Users = require('./models/Users');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const JWT_SECRET = process.env.JWT_SECRET

app.use(cors());
app.use(express.json());

// Custom log emitter
function logToClient(msg) {
  console.log(msg);
  io.emit('server-log', msg);
}

// ✅ Connect to MongoDB
mongoose.connect(process.env.MONGOURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => logToClient('✅ MongoDB connection successful!'))
  .catch((err) => {
    logToClient('❌ MongoDB connection error: ' + err);
    process.exit(1);
  });

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    logToClient(`🧩 [LOGIN] Attempt received for ${email || "(missing email)"}`);

    if (!email || !password) {
      logToClient("⚠️ [LOGIN] Missing email or password field.");
      return res.status(400).json({ msg: "Email and password are required" });
    }

    // Find user in DB
    const user = await Users.findOne({ email });
    if (!user) {
      logToClient(`❌ [LOGIN] No user found for ${email}`);
      return res.status(404).json({ msg: "User not found" });
    }

    logToClient(`✅ [LOGIN] User found: ${user.email}`);
    logToClient(`🔒 [LOGIN] Stored hashed password: ${user.password}`);

    // Compare password with bcrypt
    const isMatch = await bcrypt.compare(password, user.password);
    logToClient(`🔍 [LOGIN] bcrypt.compare() result: ${isMatch}`);

    if (!isMatch) {
      logToClient(`❌ [LOGIN] Password mismatch for ${user.email}`);
      return res.status(401).json({ msg: "Invalid credentials" });
    }

    // Generate JWT if passwords match
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    logToClient(`✅ [LOGIN] Login successful for ${user.email}`);
    logToClient(`🎟️ [LOGIN] JWT token issued -> expires in 2h`);

    res.json({
      msg: "Login successful",
      token,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    logToClient(`💥 [LOGIN] Internal error: ${err.message}`);
    res.status(500).json({ msg: "Internal server error", error: err.message });
  }
});


// Checks if the incoming request has a valid JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(403).json({ msg: "No token provided" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ msg: "Invalid or expired token" });

    req.user = decoded;
    next();
  });
}

app.get("/me", verifyToken, async (req, res) => {
  const user = await Users.findById(req.user.id).select("-password");
  res.json(user);
});


// Helper: get PayPal access token
async function getPayPalAccessToken(clientId, clientSecret) {
  const res = await axios({
    url: `${process.env.PAYPAL_API}/v1/oauth2/token`,
    method: 'post',
    auth: {
      username: clientId,
      password: clientSecret,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'grant_type=client_credentials',
  });
  return res.data.access_token;
}

// Route: Send Money
app.post('/send-money', async (req, res) => {
  try {
    const { sender, recipient, amount, broadcastToEthereum } = req.body;

    if (!sender || !recipient || !amount) {
      logToClient('⚠️ Missing sender, recipient, or amount.');
      return res.status(400).json({ error: 'Missing sender/recipient/amount' });
    }

    logToClient(`💸 Sending transaction: ${amount} USD from ${sender} → ${recipient}`);
    logToClient('🚦 Starting blockchain & HMAC verification via Python...');

    const user = await Users.findOne({ email: sender });
    if (!user) {
      logToClient(`❌ ${sender} Sender not found`);
      return res.status(404).json({ msg: `${sender} not found` });
    }

    const pythonInput = { sender, recipient, amount, broadcastToEthereum };

    // starting python code from here to verify user
    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify(pythonInput));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
      let result;
      
      try {
        result = JSON.parse(data.toString());
      } catch (e) {
        logToClient('❌ Invalid JSON from Python script: ' + data.toString());
        return res.status(500).json({ error: 'Invalid verifier output' });
      }

      if (!result.valid) {
        logToClient('❌ Transaction verification failed: ' + result.error);
        return res.status(400).json({ error: 'Transaction verification failed', details: result.error });
      }

      const blockHash = result.block_hash || null;
      logToClient('✅ Verified by blockchain. Block hash: ' + blockHash);

      // Always log Ethereum result from Python
      const ethTxHash = result.ethereum_tx || null;
      logToClient(`🌐 Ethereum tx status from Python: ${result.ethereum_status}, hash: ${ethTxHash || 'none'}`);

      // PayPal Payout
      try {
        const token = await getPayPalAccessToken(user.paypal_client_id, user.paypal_client_secret);
        const payoutBody = {
          sender_batch_header: {
            sender_batch_id: `batch_${Date.now()}`,
            email_subject: "You've received a payment",
          },
          items: [
            {
              recipient_type: 'EMAIL',
              amount: { value: amount, currency: 'USD' },
              receiver: recipient,
              note: 'Payout via blockchain verification',
            },
          ],
        };

        const payoutRes = await axios.post(
          `${process.env.PAYPAL_API}/v1/payments/payouts`,
          payoutBody,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        logToClient('✅ PayPal payout successful.');

        // Save to MongoDB
        const newTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          ethereumTxHash: ethTxHash,
          status: result.ethereum_status === 'error' ? 'partial' : 'completed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await newTx.save();
        logToClient('🗃️ Transaction saved to MongoDB.');
        logToClient('🏁 Execution complete — transaction fully successful.');

        return res.json({
          status: 'success',
          python_block_hash: blockHash,
          ethereum_tx_hash: ethTxHash || 'skipped',
          broadcasted_to_ethereum: broadcastToEthereum,
          paypal_response: payoutRes.data,
        });

      } catch (paypalErr) {
        logToClient('❌ PayPal payout failed: ' + (paypalErr.response ? JSON.stringify(paypalErr.response.data) : paypalErr.message));

        const failedTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          ethereumTxHash: ethTxHash || null,
          status: 'failed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await failedTx.save();
        logToClient('⚠️ Failed transaction saved to MongoDB.');
        return res.status(500).json({
          error: 'PayPal API error',
          details: paypalErr.response ? paypalErr.response.data : paypalErr.message,
        });
      }
    });

    python.stderr.on('data', (d) => logToClient('🐍 Python stderr: ' + d.toString()));
    python.on('close', (code) => logToClient(`🐍 Python exited with code: ${code}`));

  } catch (err) {
    logToClient('❌ Server error: ' + err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Route to manually create transactions
app.post('/transactions', async (req, res) => {
  try {
    const { sender, recipient, amount, blockHash, status, broadcasted } = req.body;

    const newTx = new TransactionsSchema({
      sender,
      recipient,
      amount,
      blockHash,
      ethereumTxHash: ethTxHash || null,
      status: ethTxHash ? 'completed' : 'partial', // decide based on runtime
      broadcasted: broadcastToEthereum,
      timestamp: new Date(),
    });


    await newTx.save();
    logToClient('🗃️ Custom transaction added to MongoDB.');
    res.status(201).json(newTx);
  } catch (err) {
    logToClient('❌ Error saving custom transaction: ' + err.message);
    res.status(400).json({ error: err.message });
  }
});

// Route to fetch transactions
app.get('/get-transactions', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const isAdmin = req.user.role === 'admin';  // for admin roles

    const filter = isAdmin ? {} : {
      $or: [{ sender: userEmail }, { recipient: userEmail }]
    };

    const txs = await TransactionsSchema.find(filter).sort({ timestamp: -1 });

    console.log(`📊 ${isAdmin ? 'Admin' : userEmail} fetched ${txs.length} txs`);
    res.json(txs);
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// app.get('/user-data', async (req, res) => {
//   try {
//     const userData = await Users.find();
//     return res.json(userData);

//   } catch (error) {
//     res.status(500).json({ msg: `Unable to fetch data: ${error} `});
//   }
// });

// internal
app.post("/dev/user", async (req, res) => {
  try {
    const devToken = req.headers["x-dev-token"];
    if (devToken !== process.env.DEV_ADMIN_TOKEN) {
      return res.status(403).json({ msg: "Unauthorized dev access" });
    }

    const {
      action,
      name,
      email,
      password,
      role,
      paypal_client_id,
      paypal_client_secret,
      sandbox_email,
      newPassword,
    } = req.body;

    switch (action) {
      // ✅ CREATE USER
      case "create":
        if (!email || !password || !paypal_client_id || !paypal_client_secret) {
          return res.status(400).json({ msg: "Missing required fields" });
        }

        const existingUser = await Users.findOne({ email });
        if (existingUser)
          return res.status(409).json({ msg: "User already exists" });

        // ⚙️ Let the Mongoose pre-save hook hash the password automatically
        const newUser = new Users({
          name,
          email,
          password, // plain here; schema will hash before save
          role: role || "user",
          paypal_client_id,
          paypal_client_secret,
          sandbox_email,
        });

        await newUser.save();
        return res.json({ msg: `✅ User created successfully: ${email}` });

      // ✅ CHANGE PASSWORD
      case "change-password":
        if (!email || !newPassword)
          return res.status(400).json({ msg: "Missing email or new password" });

        const user = await Users.findOne({ email });
        if (!user) return res.status(404).json({ msg: "User not found" });

        // ⚙️ assign plain text — will be hashed automatically by pre-save hook
        user.password = newPassword;
        await user.save();

        return res.json({ msg: `🔑 Password updated successfully: ${email}` });

      // ✅ LIST USERS (passwords hidden)
      case "list":
        const users = await Users.find({}, "-password");
        return res.json(users);

      // ✅ DELETE USER
      case "delete":
        if (!email)
          return res.status(400).json({ msg: "Email required for deletion" });
        await Users.deleteOne({ email });
        return res.json({ msg: `🗑️ User ${email} deleted` });

      default:
        return res.status(400).json({ msg: "Invalid action" });
    }
  } catch (err) {
    console.error("❌ Dev route error:", err);
    res.status(500).json({ msg: "Internal server error", error: err.message });
  }
});


// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => logToClient(`🚀 Server running on port ${PORT}`));

// Handle Socket.IO connections
io.on('connection', (socket) => {
  console.log('🧠 Browser connected for live logs.');
  socket.emit('server-log', '📡 Connected to live backend logs!');
});
