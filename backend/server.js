const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { Readable } = require("stream");
const { google } = require("googleapis");
const dotenv = require("dotenv");
dotenv.config();
const client_email = process.env.CLIENT_EMAIL;
const private_key = process.env.PRIVATE_KEY;

const SCOPE = ["https://www.googleapis.com/auth/drive"];

async function authorize() {
  const jwtClient = new google.auth.JWT(client_email, null, private_key, SCOPE);

  await jwtClient.authorize();
  return jwtClient;
}

async function uploadFile(authClient, file) {
  console.log("Uploading file:", file.originalname);
  return new Promise((resolve, reject) => {
    const drive = google.drive({ version: "v3", auth: authClient });

    const fileMetadata = {
      name: file.originalname,
      parents: ["1ueuFJ6-wbVg9mAekQ4r5pStfIaUzDrmm"],
    };

    const media = {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path),
    };

    drive.files.create(
      {
        resource: fileMetadata,
        media,
        fields: "id",
      },
      (err, response) => {
        fs.unlinkSync(file.path);

        if (err) {
          console.error("Error uploading file to Google Drive:", err);
          return reject(err);
        }

        const fileId = response.data.id;
        const fileUrl = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
        console.log("File uploaded successfully:", fileUrl);
        resolve(fileUrl);
      }
    );
  });
}

const app = express();
const port = 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*",
  })
);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const uri =
  "mongodb+srv://falcona-finace:VO69BlrDaZbFrVtW@cluster0.f4z7u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error("Invalid file type. Only PDF and DOC/DOCX are allowed."),
        false
      );
    }
  },
});

const run = async () => {
  try {
    await client.connect();
    const database = client.db("FalconaDB");
    const contactCollection = database.collection("contactCollection");
    const careersCollection = database.collection("careersCollection");
    const usersCollection = database.collection("usersCollection");
    const subscriptionsCollection = database.collection(
      "subscriptionsCollection"
    );

    app.get("/subscriptions", async (req, res) => {
      // console.log("GET /subscriptions");
      const data = await subscriptionsCollection.find().toArray();
      res.status(200).send(data);
    });

    app.post("/api/subscribe", async (req, res) => {
      const data = req.body;
      const subscribeAt = new Date();
      const result = await subscriptionsCollection.insertOne({
        ...data,
        subscribeAt,
      });
      res.status(200).send(result);
    });

    app.put("/api/update-password", async (req, res) => {
      const { username, oldPassword, newPassword } = req.body;
      const result = await usersCollection.updateOne(
        { username, password: oldPassword },
        { $set: { password: newPassword } }
      );
      res.status(200).send(result);
    });

    app.post("/api/user", async (req, res) => {
      const data = req.body;
      const result = await usersCollection.insertOne(data);
      res.status(200).send(result);
    });

    app.post("/user", async (req, res) => {
      const { username, password } = req.body;
      console.log("username", username);
      try {
        const user = await usersCollection.findOne({ username, password });
        if (user) {
          return res.status(200).send({ role: user?.role });
        } else {
          res.status(401).send({ message: "User not found" });
        }
      } catch (error) {
        console.log(error);
        return res.status(500).send({ message: "Server error" });
      }
    });

    app.post("/api/contact-us", async (req, res) => {
      const data = req.body;
      const submittedAt = new Date();

      try {
        const result = await contactCollection.insertOne({
          ...data,
          submittedAt,
          status: "Pending",
        });

        res.status(200).send({
          message: "Contact form submitted successfully",
          contactId: result.insertedId,
        });
      } catch (error) {
        console.error("Error inserting contact data:", error);
        res.status(500).send("Server Error");
      }
    });

    app.post("/api/careers", upload.single("resume"), async (req, res) => {
      if (!req.file) {
        return res.status(400).send({ message: "Resume file is required." });
      }

      const { name, email, phone, position, message } = req.body;

      if (!name || !email || !phone || !position || !message) {
        return res.status(400).send({ message: "All fields are required." });
      }

      try {
        //upload file to google drive
        const authClient = await authorize();
        const fileUrl = await uploadFile(authClient, req.file);

        console.log("file Url", fileUrl);

        const data = {
          name,
          email,
          phone,
          position,
          message,
          resumePath: fileUrl,
          status: "Pending",
          submittedAt: new Date(),
        };

        const result = await careersCollection.insertOne(data);

        res.status(200).send({
          message: "Careers form submitted successfully",
          careersId: result.insertedId,
        });
      } catch (error) {
        console.error("Error saving application:", error);
        res.status(500).send("Server Error");
      }
    });

    app.get("/api/data", async (req, res) => {
      try {
        const [contactData, careersData] = await Promise.all([
          contactCollection.find({}).toArray(),
          careersCollection.find({}).toArray(),
        ]);

        res.status(200).send({
          contactData,
          careersData,
        });
      } catch (error) {
        console.error("Error retrieving data:", error);
        res.status(500).send("Server Error");
      }
    });

    app.post("/toggle-status/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const objectId = new ObjectId(id);

        const contactDoc = await contactCollection.findOne({ _id: objectId });
        const careersDoc = await careersCollection.findOne({ _id: objectId });

        let targetCollection;
        if (contactDoc) {
          targetCollection = contactCollection;
        } else if (careersDoc) {
          targetCollection = careersCollection;
        } else {
          return res
            .status(404)
            .send({ message: "Document not found in any collection" });
        }

        const currentDoc = contactDoc || careersDoc;
        const newStatus =
          currentDoc.status === "Pending" ? "Confirm" : "Pending";

        const result = await targetCollection.updateOne(
          { _id: objectId },
          { $set: { status: newStatus } }
        );

        if (result.modifiedCount === 1) {
          res
            .status(200)
            .send({ message: "Status toggled successfully", newStatus });
        } else {
          res.status(500).send({ message: "Failed to toggle status" });
        }
      } catch (error) {
        console.error("Error toggling status:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.delete("/deleteSubscriptions/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const objectId = new ObjectId(id);
        const result = await subscriptionsCollection.deleteOne({
          _id: objectId,
        });
        if (result.deletedCount === 1) {
          res
            .status(200)
            .send({ message: "Subscription deleted successfully" });
        } else {
          res.status(404).send({ message: "Subscription not found" });
        }
      } catch (error) {
        console.error("Error deleting subscription:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.delete("/deleteCareer/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const objectId = new ObjectId(id);
        const result = await careersCollection.deleteOne({ _id: objectId });
        if (result.deletedCount === 1) {
          res.status(200).send({ message: "Career deleted successfully" });
        } else {
          res.status(404).send({ message: "Career not found" });
        }
      } catch (error) {
        console.error("Error deleting career:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    console.log("Successfully connected to MongoDB!");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  }
};

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on ${port}`);
});
