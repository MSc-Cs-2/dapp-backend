const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const { spawn } = require('child_process');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());


app.get('/', (req, res) => res.send("API server up!"));

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
    const { sender, recipient, amount, signature } = req.body;

    if (!sender || !recipient || !amount || !signature) {
        return res.status(400).json({ error: 'Missing sender/recipient/amount/signature' });
    }

    console.log(`Verifying transaction ${amount} from ${sender} → ${recipient}`);

    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify({ sender, recipient, amount, signature })); // sends data via nodejs to python code
    python.stdin.end();

    python.stdout.on('data', async (data) => {
        const result = JSON.parse(data.toString());
        if (result.valid) {
            console.log(`Transaction verified and recorded in blockchain. Block hash: ${result.block_hash}`);

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

                return res.json({
                    status: 'success',
                    block_hash: result.block_hash,
                    paypal_response: payout.data
                });

            } catch (err) {
                console.error(err);
                return res.status(500).json({ error: 'PayPal API error' });
            }
            
        } else {
            return res.status(400).json({ error: 'Transaction verification failed' });
        }
    });

    python.stderr.on('data', (data) => console.error('Python error:', data.toString()));
});

app.get('/get-balance', async (req, res) => {
    try {
        const token = await getPayPalAccessToken();

        //const response = await fetch(`${process.env.PAYPAL_API}/v1/reporting/balances?currency_code=USD`, {
        const response = await fetch(`${process.env.PAYPAL_API}/v2/wallet/balance-accounts`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            }
        });

        const data = await response.json();

        res.json({ balances: data.balances });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to fetch balance' });
    }
});

app.get('/get-all-transactions', async (req, res) => {
    const token = getPayPalAccessToken();

    // 30 days worth of transactions
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const end = new Date();

    const response = await fetch(`${process.env.PAYPAL_API}/v1/reporting/transactions`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`
        },
        params: {
            start_date: start.toISOString(),
            end_date: end.toISOString(),
            page_size: 20,
            fields: 'all'
        }
    });

    res.json({ allTransactions: response.json() })

})

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
