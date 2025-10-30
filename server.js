// server.js
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// --- Ethereum setup (only if you want on-chain logging) ---
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL); // must be testnet RPC
const wallet = new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY || '', provider);

// small helper to get PayPal access token
async function getPayPalAccessToken() {
  const res = await axios({
    url: `${process.env.PAYPAL_API}/v1/oauth2/token`,
    method: 'post',
    auth: {
      username: process.env.PAYPAL_CLIENT_ID,
      password: process.env.PAYPAL_SECRET
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'grant_type=client_credentials'
  });
  return res.data.access_token;
}

app.post('/send-money', async (req, res) => {
  try {
    const { sender, recipient, amount, signature } = req.body;
    if (!sender || !recipient || !amount || !signature) {
      return res.status(400).json({ error: 'Missing sender/recipient/amount/signature' });
    }

    console.log(`Verifying transaction ${amount} from ${sender} → ${recipient}`);

    // run python verifier: send JSON via stdin and expect JSON back on stdout
    const python = spawn('python', ['../blockchain/blockchain.py']); // adjust path if needed
    python.stdin.write(JSON.stringify({ sender, recipient, amount, signature }));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
      let result;
      try {
        result = JSON.parse(data.toString());
      } catch (e) {
        console.error('Invalid JSON from python:', data.toString());
        return res.status(500).json({ error: 'Invalid verifier output' });
      }

      if (!result.valid) {
        return res.status(400).json({ error: 'Transaction verification failed', details: result.error });
      }

      // result.valid === true, result.block_hash should be available from python
      const blockHash = result.block_hash || null;
      console.log('Verified by blockchain, python block hash:', blockHash);

      // Broadcast Ethereum log
      let ethTxHash = null;
      try {
        // metadata we record on-chain (optional)
        const metadata = JSON.stringify({ sender, recipient, amount, timestamp: Date.now(), block_hash: blockHash });
        const dataHex = ethers.hexlify(ethers.toUtf8Bytes(metadata));

        // If you only want to log data and do NOT want to spend ETH remove below and skip
        const tx = await wallet.sendTransaction({
          to: wallet.address,      // change to recipient address if you want the tx to target recipient
          value: 0,
          data: dataHex
        });
        console.log('Ethereum tx sent:', tx.hash);

        // wait for the tx to be mined/confirmed
        const receipt = await tx.wait();
        ethTxHash = tx.hash;
        console.log('Ethereum tx confirmed in block', receipt.blockNumber);

      } catch (ethErr) {
        console.error('Ethereum logging failed:', ethErr.message || ethErr);
        // If wallet has insufficient funds you'll see error here. You can still proceed to PayPal if you want:
        // return res.status(500).json({ error: 'Ethereum logging failed', details: ethErr.message });
        // For now we will continue to PayPal even if Ethereum log fails
      }

      // Execute PayPal payout
      try {
        const token = await getPayPalAccessToken();

        // IMPORTANT:
        // Make sure your sandbox business app has Payouts enabled.
        // The recipient below must be a sandbox account email.
        const payoutBody = {
          sender_batch_header: {
            sender_batch_id: `batch_${Date.now()}`,
            email_subject: "You've received a payment"
          },
          items: [{
            recipient_type: 'EMAIL',
            amount: { value: amount, currency: 'USD' },
            receiver: recipient,
            note: 'Payout via blockchain verification'
          }]
        };

        const payoutRes = await axios.post(
          `${process.env.PAYPAL_API}/v1/payments/payouts`,
          payoutBody,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        // payoutRes.data contains PayPal response (batch id, items, links)
        return res.json({
          status: 'success',
          python_block_hash: blockHash,
          ethereum_tx_hash: ethTxHash,
          paypal_response: payoutRes.data
        });

      } catch (paypalErr) {
        console.error('PayPal payout failed:', paypalErr.response ? paypalErr.response.data : paypalErr.message);
        return res.status(500).json({ error: 'PayPal API error', details: paypalErr.response ? paypalErr.response.data : paypalErr.message });
      }
    });

    python.stderr.on('data', (d) => console.error('Python stderr:', d.toString()));
    python.on('close', (code) => console.log('Python exited with', code));

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
