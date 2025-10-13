const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const { spawn } = require('child_process');

dotenv.config();
const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => res.send("API server up!"));

async function getPayPalAccessToken() {
    const res = await axios({
        url: `${process.env.PAYPAL_API}/v1/oauth2/token`,
        method: 'post',
        auth: {
            username: process.env.PAYPAL_CLIENT_ID,
            password: process.env.PAYPAL_SECRET
        },
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        data: 'grant_type=client_credentials'
    });
    return res.data.access_token;
}

app.post('/send-money', async (req, res) => {
    const { sender, recipient, amount, signature } = req.body;
    if (!sender || !recipient || !amount || !signature) {
        return res.status(400).json({error: 'Missing sender/recipient/amount/signature'});
    }

    console.log(`Verifying transaction from ${sender} -> ${recipient} for ${amount}`);

    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify({sender, recipient, amount, signature}));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
        const result = JSON.parse(data.toString());
        if (result.valid) {
            console.log("Transaction verified. Sending via PayPal...");
            try {
                const token = await getPayPalAccessToken();
                const payout = await axios.post(`${process.env.PAYPAL_API}/v1/payments/payouts`, {
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
                }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

                return res.json({status: 'success', paypal_response: payout.data});
            } catch (err) {
                console.error(err);
                return res.status(500).json({error: 'PayPal API error'});
            }
        } else {
            return res.status(400).json({error: 'Transaction verification failed'});
        }
    });

    python.stderr.on('data', (data) => console.error('Python error:', data.toString()));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
