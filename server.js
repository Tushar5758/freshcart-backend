const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const busboy = require("busboy");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const uuid = require("uuid");
require('dotenv').config();

const app = express();

// Enhanced CORS configuration
app.use(cors({
    origin: "*",  // Allow any origin; replace '*' with specific domain if needed
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public"))); // Serve static files

// SQLite Database Setup
const db = new sqlite3.Database("database.db");

// Ensure tables exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price REAL,
        stock INTEGER,
        unit TEXT,
        category TEXT,
        image BLOB
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        address TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        total_amount REAL
    )`);
});

// ** File Upload Middleware **
const handleFileUpload = (req, res, next) => {
    if (!req.is("multipart/form-data")) {
        return next();
    }

    const bb = busboy({ headers: req.headers });
    req.body = {};
    req.file = null;

    bb.on("file", (name, file) => {
        const chunks = [];
        file.on("data", (data) => chunks.push(data));
        file.on("end", () => {
            req.file = Buffer.concat(chunks);
        });
    });

    bb.on("field", (name, val) => {
        req.body[name] = val;
    });

    bb.on("close", () => {
        next();
    });

    req.pipe(bb);
};

// ** Serve Images from Database **
app.get("/image/:id", (req, res) => {
    db.get("SELECT image FROM inventory WHERE id = ?", req.params.id, (err, row) => {
        if (err || !row || !row.image) {
            return res.status(404).send("Image not found");
        }

        res.contentType("image/jpeg");
        res.send(Buffer.from(row.image));
    });
});

// ** Serve HTML File **
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "home.html"));
});

// ** NEW ENDPOINT: Get products by category **
app.get("/products", (req, res) => {
    const category = req.query.category;
    let query = "SELECT id, name, price, stock, unit, category, image FROM inventory";
    let params = [];
    
    if (category) {
        query += " WHERE category = ?";
        params.push(category);
    }
    
    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        // Convert image BLOBs to base64 for client-side display
        const productsWithBase64 = rows.map(product => {
            return {
                id: product.id,
                name: product.name,
                price: product.price,
                stock: product.stock,
                unit: product.unit,
                category: product.category,
                image: product.image ? product.image.toString('base64') : null
            };
        });

        res.json(productsWithBase64);
    });
});

// ** Inventory Management with Image Upload **
app.post("/addProduct", handleFileUpload, (req, res) => {
    const { name, price, stock, unit, category } = req.body;
    const image = req.file || null;

    db.run(
        "INSERT INTO inventory (name, price, stock, unit, category, image) VALUES (?, ?, ?, ?, ?, ?)",
        [name, price, stock, unit, category, image],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            res.json({
                message: "Product added!",
                product: {
                    id: this.lastID,
                    name, price, stock, unit, category,
                    imageUrl: image ? `/image/${this.lastID}` : null
                }
            });
        }
    );
});

app.get("/getInventory", (req, res) => {
    db.all("SELECT id, name, price, stock, unit, category, (image IS NOT NULL) as hasImage FROM inventory", (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        rows.forEach(row => {
            row.image = row.hasImage ? `/image/${row.id}` : null;
            delete row.hasImage;
        });

        res.json(rows);
    });
});

// ** User Registration with Address **
app.post("/register", (req, res) => {
    const { name, username, email, address, password } = req.body;

    if (!name || !username || !email || !address || !password) {
        return res.status(400).json({ message: "All fields are required" });
    }

    db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
        if (err) return res.status(500).json({ message: "Database error" });
        if (row) return res.status(400).json({ message: "Username or Email already exists" });

        bcrypt.hash(password, 10, (err, hashedPassword) => {
            if (err) return res.status(500).json({ message: "Error hashing password" });

            db.run(
                "INSERT INTO users (name, username, email, password, address) VALUES (?, ?, ?, ?, ?)",
                [name, username, email, hashedPassword, address],
                function (err) {
                    if (err) return res.status(500).json({ message: "Error inserting user" });
                    res.status(201).json({ message: "User registered successfully" });
                }
            );
        });
    });
});

// ** User Login **
app.post("/login", (req, res) => {
    const { username, password } = req.body;

    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        if (!user) return res.status(401).json({ success: false, message: "Invalid Username!" });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ success: false, message: "Invalid Password!" });

        res.json({ success: true, message: "Login successful!" });
    });
});

// ** Get single product by ID **
app.get("/product/:id", (req, res) => {
    db.get("SELECT id, name, price, stock, unit, category, image FROM inventory WHERE id = ?", 
        [req.params.id], 
        (err, product) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (!product) {
                return res.status(404).json({ error: "Product not found" });
            }
            
            // Convert image BLOB to base64
            if (product.image) {
                product.image = product.image.toString('base64');
            }
            
            res.json(product);
    });
});

// ** Fetch Bills **
app.get("/getBills", (req, res) => {
    db.all("SELECT * FROM bills", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ** Delete Product **
app.delete("/deleteProduct/:id", (req, res) => {
    db.run("DELETE FROM inventory WHERE id=?", req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted!" });
    });
});

// ** Update Product with Optional Image Upload **
app.put("/updateProduct/:id", handleFileUpload, (req, res) => {
    const { name, price, stock, unit, category } = req.body;

    if (req.file) {
        db.run("UPDATE inventory SET name=?, price=?, stock=?, unit=?, category=?, image=? WHERE id=?", 
            [name, price, stock, unit, category, req.file, req.params.id], 
            (err) => err ? res.status(500).json({ error: err.message }) : res.json({ message: "Updated!" })
        );
    } else {
        db.run("UPDATE inventory SET name=?, price=?, stock=?, unit=?, category=? WHERE id=?", 
            [name, price, stock, unit, category, req.params.id], 
            (err) => err ? res.status(500).json({ error: err.message }) : res.json({ message: "Updated!" })
        );
    }
});

// ** Start Server **
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Server is accessible at http://localhost:${PORT}`);
});