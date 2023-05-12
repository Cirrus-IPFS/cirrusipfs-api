const { NFTStorage } = require('nft.storage')
const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const { Readable } = require('stream');
const cors = require("cors")
const bodyParser = require('body-parser');
const firebase = require('firebase/app');
require('firebase/auth');
const app = express();
const admin = require('firebase-admin');
const serviceAccount = require('./firebaseService.json');
const jwt_decode = require("jwt-decode")
const fs = require('fs')
const https = require("https");
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

app.use(cors())

// Initialize Firebase app with your project credentials
const firebaseConfig = {
  // -------------- Firebase Config --------------------------------------
};

const firebaseAuthUrl = 'https://identitytoolkit.googleapis.com/v1/accounts';
const apiKey ="<firebase api key>"

firebase.initializeApp(firebaseConfig);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: '<FIREBASE DATABASE>',
});

var db = admin.database();
const users = db.ref('users');
const share = db.ref('share');
const onetime = db.ref('onetime');
// Use the body-parser middleware to parse incoming JSON data
app.use(bodyParser.json());

// configure multer middleware to handle file uploads
const upload = multer({
  storage: multer.memoryStorage()
}).single('file');

function setUpUser(userId, name, email) {
  const usersRef = users.child(userId);
  usersRef.set({
    email: email,
    name: name,
    total: 45,
    used: 0
  });
}


function separateFileNameAndExtension(filename) {
  const parts = filename.split(".");
  const extension = parts.pop();
  const name = parts.join(".");
  return { name, extension };
}

var ipfsNodes = [
  "IPFS NODES IP ADDRESS"
]

var requestCount = 0;

const endpoint = 'https://api.nft.storage' // the default
const token = 'NFT STORAGE API KEY' // your API key from https://nft.storage/manage

const sslServer = https.createServer({
  key: fs.readFileSync('/etc/letsencrypt/live/api.usecirrus.cloud/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/api.usecirrus.cloud/fullchain.pem')
}, app)

async function decryptContent(cipherText, key) {
  console.log(key)
  // Extract the IV and encrypted data
  const iv = cipherText.slice(0, 16);
  const data = cipherText.slice(16);

  // Create a decipher object using the same encryption key and IV
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  // Decrypt the data
  const decryptedData = Buffer.concat([decipher.update(data), decipher.final()]);
  return decryptedData
}



app.post('/upload', upload, async (req, res) => {
  const userAuth = req.headers.auth;
  const folder = req.body.folder;
  const fileName = req.body.filename;
  const size = req.body.size;
  const fileSizeByte = size * (1024 * 1024);
  const isPrivate = req.body.isPrivate;
  const maxFileSizeByte = 300 * (1024 * 1024); // set max file size limit to 300 M


  var { name, extension } = separateFileNameAndExtension(fileName);

  console.log(folder, fileName, size)
  var decoded = jwt_decode(userAuth);
  console.log(decoded);
  const { originalname, buffer } = req.file;

  if (fileSizeByte > maxFileSizeByte) {
    res.status(400).send({ message: "File size exceeds maximum limit of 300 MB" });
    return; // return early to stop further processing
  }
  
  try {
    var vals = await new Promise((resolve, reject) => {
      users.child(decoded.sub).on('value', (snapshot) => {
        console.log(snapshot.val());
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });

    if(vals.used >= 45)
    {
      res.send({message: "Storage Fulled"})
    }else{
      console.log(isPrivate)
      if(isPrivate == "true")
      {
        const encryptionKey = crypto.randomBytes(16).toString('hex');
        const storage = new NFTStorage({ endpoint, token});

        // Encrypt the buffer data using AES
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
        const encryptedData = Buffer.concat([iv, cipher.update(buffer), cipher.final()]);

        // Upload the encrypted data to nft.storage
        const blob = new Blob([encryptedData]);
        const cid = await storage.storeBlob(blob);

        console.log(`https://ipfs.io/ipfs/${cid}?filename=2.psd`);

        const ipfsHash = cid;
        await storage.status(cid);

        const fileStream = Readable.from(buffer);
        const form = new FormData();
        form.append('file', fileStream, { filename: req.file.originalname });

        
        const response = await axios.post('http://<IPFS MAIN NODE IP>:5001/api/v0/add', form, {
          headers: { 'Content-Type': `multipart/form-data; boundary=${form._boundary}` }
        });

        ipfsNodes.map((node) => {
          axios.post(`http://${node}:5001/api/v0/object/stat?arg=${ipfsHash}`)
            .then(response => {
              console.log(`Node ${node} responded with status ${response.status}`);
            })
            .catch(error => {
              console.log(`Error from node ${node}: ${error.message}`);
            });
        });

        const base58_response = await axios.post(`http://<IPFS MAIN NODE IP>:5001/api/v0/cid/format?arg=${ipfsHash}&f=%s&b=base58btc`);

        console.log(base58_response)

        console.log(response)
        const usersRef = users.child(decoded.sub).child(folder).child(name);
        const IDs = crypto.randomBytes(16).toString('hex');
        usersRef.set({
          id: IDs,
          name: name,
          hash: base58_response.data.Formatted || ipfsHash,
          size: size,
          extension: extension,
          private: true
        });

        const private = users.child(decoded.sub).child('private').child(IDs.toString());
        private.set({
          id: IDs,
          name: name,
          hash: base58_response.data.Formatted || ipfsHash,
          size: size,
          extension: extension,
          key: encryptionKey
        });

        const usersR = users.child(decoded.sub);
        usersR.update({
          name: vals.name,
          email: vals.email,
          total: 45,
          used: vals.used + (fileSizeByte / (1024 * 1024 * 1024))
        });

        ipfsNodes.map((node) => {
          axios.post(`http://${node}:5001/api/v0/object/stat?arg=${cid}`)
            .then(response => {
              console.log(`Node ${node} responded with status ${response.status}`);
            })
            .catch(error => {
              console.log(`Error from node ${node}: ${error.message}`);
            });
        });
        res.send(cid);
      }else{
        // Pack the file buffer into a CAR
        const storage = new NFTStorage({ endpoint, token })

        // locally chunk'n'hash the file to get the CID and pack the blocks in to a CAR
        try{
          var cid = await storage.storeBlob(new Blob([buffer]))
          console.log(cid)

          // Increment the request count and check if we've hit the limit of 5 requests
          requestCount++;
          if (requestCount % 5 === 0) {
            // Wait for 5 seconds before sending the response
            await new Promise(resolve => setTimeout(resolve, 5000));
          }

          if (name.includes('.')) {
            // Extract the name without the extension
            const nameWithoutExtension = name.split('.')[0];
            name = nameWithoutExtension
          }

          // extract the IPFS hash from the response data and send it back to the client
          console.log(cid)
        }catch(err){
          console.log(err.message)
        }
        // console.log(response.data?.error)
        const ipfsHash = cid;
        const base58_response = await axios.post(`http://<IPFS MAIN NODE IP>:5001/api/v0/cid/format?arg=${ipfsHash}&f=%s&b=base58btc`);
        console.log(base58_response)
        const usersRef = users.child(decoded.sub).child(folder).child(name);
        usersRef.set({
          name: name,
          hash: base58_response.data.Formatted || ipfsHash,
          size: size,
          extension: extension
        });

        const usersR = users.child(decoded.sub);
        usersR.update({
          name: vals.name,
          email: vals.email,
          total: 45,
          used: vals.used + (fileSizeByte / (1024 * 1024 * 1024))
        });
        
        ipfsNodes.map((node) => {
          axios.post(`http://${node}:5001/api/v0/pin/add?arg=${cid}`)
            .then(response => {
              console.log(`Node ${node} responded with status ${response.status}`);
            })
            .catch(error => {
              console.log(`Error from node ${node}: ${error.message}`);
            });
        })

        ipfsNodes.map((node) => {
          axios.post(`http://${node}:5001/api/v0/object/stat?arg=${ipfsHash}`)
            .then(response => {
              console.log(`Node ${node} responded with status ${response.status}`);
            })
            .catch(error => {
              console.log(`Error from node ${node}: ${error.message}`);
            });
        });
        storage.delete(cid)
        res.send(cid);
      }
    }
  } catch (error) {
    console.error(error);
    //res.status(500).send('Server error');
  }
});


app.get('/get/:ids', upload, async (req, res) => {
  const userAuth = req.headers.auth;

  var decoded = jwt_decode(userAuth);

  try {
    const hash1 = req.params.ids;
    var vals = await new Promise((resolve, reject) => {
      users.child(decoded.sub).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });
    var userPrivate = vals.private[hash1]

    const cid = userPrivate.hash;
    const response = await axios.get(`https://ipfs.io/ipfs/${cid}`);
    const encryptedFile = response.data;

    // Decrypt the file using the encryption key
    const decryptedContent = await decryptContent(encryptedFile, userPrivate.key);

    // Send the decrypted content to the user
    res.send(decryptedContent);
    
  } catch (error) {
    console.error(error);
    //res.status(500).send('Server error');
  }
});

app.get('/api/token', async(req, res) => {

  const userAuth = req.headers.auth;
  var decoded = jwt_decode(userAuth);
  var name = req.body.name;

  var vals = await new Promise((resolve, reject) => {
    users.child(decoded.sub).on('value', (snapshot) => {
      resolve(snapshot.val());
    }, (errorObject) => {
      console.log('The read failed: ' + errorObject.name);
      reject(errorObject);
    }); 
  });

  if(vals?.api?.api != undefined){
    res.send({message: "Token already exists."})
  }
  else{
    const usersR = users.child(decoded.sub).child("api");
    const secretKey = fs.readFileSync('/etc/letsencrypt/live/api.usecirrus.cloud/privkey.pem'); // Replace with your own secret key
    const tok = jwt.sign({ sub: decoded.sub }, secretKey, { algorithm: 'RS256',expiresIn: '1h' }); // Create a JWT token with a username payload that expires in 1 hour
    const usersRef = users.child(decoded.sub).child('api');
    usersRef.set({
      desc: name,
      api: tok,
      status: "Active"
    });

    res.json({ token }); // Send the token in a JSON response
  }
});

async function decryptFile(encryptedData, encryptionKey) {
  // Extract the IV and encrypted data
  const iv = encryptedData.slice(0, 16);
  const data = encryptedData.slice(16);

  // Create a decipher object using the same encryption key and IV
  const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);

  // Decrypt the data
  const decryptedData = Buffer.concat([decipher.update(data), decipher.final()]);

  // Return the decrypted data as a buffer
  return decryptedData;
}


app.get('/decrypt/:cid', async (req, res) => {
  const userAuth = req.headers.auth;

  var decoded = jwt_decode(userAuth);

  try {
    const hash1 = req.params.cid;

    var vals = await new Promise((resolve, reject) => {
      share.child(hash1).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });
    var userPrivate = vals

    console.log(userPrivate)
    // Download the encrypted file from IPFS using a public gateway
    const response = await axios.get(`https://gateway.ipfscdn.io/ipfs/${userPrivate.hash}/`, {
      responseType: 'arraybuffer'
    });
    const encryptedData = response.data;

    // Extract the encryption key from a secure location
    const encryptionKey = userPrivate.key;  

    // Decrypt the data
    const decryptedData = await decryptFile(encryptedData, encryptionKey);

    // Set the response headers and send the decrypted data back to the user
    res.set('extension', userPrivate.extension)
    res.type(userPrivate.extension).send(decryptedData);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while decrypting the file.');
  }
});

app.get('/get/extension/:cid', async (req, res) => {
  const userAuth = req.headers.auth;

  var decoded = jwt_decode(userAuth);

  try {
    const hash1 = req.params.cid;

    var vals = await new Promise((resolve, reject) => {
      share.child(hash1).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });
    var userPrivate = vals

    res.send({extension: userPrivate.extension});
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while decrypting the file.');
  }
});

app.get('/onetime/extension/:cid', async (req, res) => {
  const userAuth = req.headers.auth;

  var decoded = jwt_decode(userAuth);

  try {
    const hash1 = req.params.cid;

    var vals = await new Promise((resolve, reject) => {
      onetime.child(hash1).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });
    var userPrivate = vals

    if(userPrivate != undefined || userPrivate != null)
    {
      onetime.child(hash1).remove();
    }
    res.send({extension: userPrivate.extension});
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while decrypting the file.');
  }
});

app.get('/decrypt/onetime/:cid', async (req, res) => {
  const userAuth = req.headers.auth;

  var decoded = jwt_decode(userAuth);

  try {
    const hash1 = req.params.cid;

    var vals = await new Promise((resolve, reject) => {
      onetime.child(hash1).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });
    var userPrivate = vals

    console.log(userPrivate)
    // Download the encrypted file from IPFS using a public gateway
    const response = await axios.get(`https://gateway.ipfscdn.io/ipfs/${userPrivate.hash}/`, {
      responseType: 'arraybuffer'
    });
    const encryptedData = response.data;

    // Extract the encryption key from a secure location
    const encryptionKey = userPrivate.key;  

    // Decrypt the data
    const decryptedData = await decryptFile(encryptedData, encryptionKey);
    // Set the response headers and send the decrypted data back to the user
    res.type(userPrivate.extension).send(decryptedData)
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while decrypting the file.');
  }
});


app.get('/user/share/:cid', async (req, res) => {
  try {
    const userAuth = req.headers.auth;

    var decoded = jwt_decode(userAuth);

    const hash1 = req.params.cid;

    const vals = await new Promise((resolve, reject) => {
      users.child(decoded.sub).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });

    const userPrivate = vals?.private?.[hash1];
    console.log(userPrivate);

    if (!userPrivate) {
      return res.status(403).send({ message: "You don't have access to this file." });
    }

    const newSes = crypto.randomBytes(16).toString('hex');

    const shareRef = share.child(newSes)
    await shareRef.update(userPrivate);
    res.send({ session: newSes, code:200 });
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while processing your request.');
  }
});

app.get('/user/onetime/:cid', async (req, res) => {
  try {
    const userAuth = req.headers.auth;

    var decoded = jwt_decode(userAuth);

    const hash1 = req.params.cid;

    const vals = await new Promise((resolve, reject) => {
      users.child(decoded.sub).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });

    const userPrivate = vals?.private?.[hash1];
    console.log(userPrivate);

    if (!userPrivate) {
      return res.status(403).send({ message: "You don't have access to this file." });
    }

    const newSes = crypto.randomBytes(16).toString('hex');

    const oneTime = onetime.child(newSes)
    await oneTime.update(userPrivate);
    res.send({ session: newSes, code:200 });
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while processing your request.');
  }
});

//   const userAuth = req.headers.auth;

//   var decoded = jwt_decode(userAuth);

//   const hash1 = req.body.cid;


//   try{
//       var vals = await new Promise((resolve, reject) => {
//         users.child(decoded.sub).on('value', (snapshot) => {
//           resolve(snapshot.val());
//         }, (errorObject) => {
//           console.log('The read failed: ' + errorObject.name);
//           reject(errorObject);
//         }); 
//     });
//     var userPrivate = vals.private[hash1]
//     console.log(userPrivate)

//     if(userPrivate == undefined)
//     {
//       res.send({mesage: "You dont access to this file."})
//     }

//     const newSes = crypto.randomBytes(16).toString('hex');

//     const shareRef = share.child(newSes)
//     shareRef.update(userPrivate);
//     res.send({session: newSes, code:200})
//   }catch(err){
//     res.send({message: err.message || err.response.data.message || "Internale Server ERROR", code: 500})
//   }
// })
// app.get('/get/:id', async (req, res) => {
//   const userAuth = req.headers.auth;

//   var decoded = jwt_decode(userAuth);
//   console.log(decoded);

//   try {
//     var vals = await new Promise((resolve, reject) => {
//       users.child(decoded.sub).on('value', (snapshot) => {
//         console.log(snapshot.val());
//         resolve(snapshot.val());
//       }, (errorObject) => {
//         console.log('The read failed: ' + errorObject.name);
//         reject(errorObject);
//       }); 
//     });

//     const cid = vals.private.id.hash;
//     const response = await axios.get(`https://ipfs.io/ipfs/${cid}`);
//     const encryptedFile = response.data;

//     // Decrypt the file using the encryption key
//     const decryptedContent = await decryptFile(encryptedFile.toString(), vals.private.id.key);

//     // Send the decrypted content to the user
//     res.send(decryptedContent);
//   } catch (error) {
//     console.error(error);
//     res.status(500).send('An error occurred');
//   }
// });

//   const hash = req.body.hash;

//   var { name, extension } = separateFileNameAndExtension(fileName);

//   console.log(folder, fileName, size)
//   var decoded = jwt_decode(userAuth);
//   console.log(decoded);
//   try {
//     // get the file buffer from the request
//     const file = req.file.buffer;

//     // create a readable stream from the file buffer
//     const fileStream = Readable.from(file);

//     // set up the FormData object to send the file as multipart/form-data
//     const form = new FormData();
//     form.append('file', fileStream, { filename: req.file.originalname });

//     const progressBar = new cliProgress.SingleBar({
//       format: 'Uploading [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} bytes',
//       clearOnComplete: true
//     });

//     progressBar.start(fileSizeByte, 0);

//     // send the file to the IPFS node API using axios
//     const response = await axios.post('http://5.135.162.92:5001/api/v0/add', form, {
//       headers: { 'Content-Type': `multipart/form-data; boundary=${form._boundary}` },
//       onUploadProgress: (progressEvent) => {
//         // update the progress bar with the current progress
//         progressBar.update(progressEvent.loaded);
//       }
//     });

//     progressBar.stop();

//     if (name.includes('.')) {
//       // Extract the name without the extension
//       const nameWithoutExtension = name.split('.')[0];
//       name = nameWithoutExtension
//     }

//     // extract the IPFS hash from the response data and send it back to the client
//     const ipfsHash = response.data.Hash;
//     const usersRef = users.child(decoded.sub).child(folder).child(name);
//     usersRef.set({
//       name: name,
//       hash: ipfsHash,
//       size: size,
//       extension: extension
//     });
    
//     ipfsNodes.map((node) => {
//       axios.post(`http://${node}:5001/api/v0/object/stat?arg=${ipfsHash}`)
//         .then(response => {
//           console.log(`Node ${node} responded with status ${response.status}`);
//         })
//         .catch(error => {
//           console.log(`Error from node ${node}: ${error.message}`);
//         });
//     });

//     res.send(ipfsHash);
//   } catch (error) {
//     console.error(error);
//     //res.status(500).send('Server error');
//   }
// });

// Define a route for registering a new user
app.post('/register', async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const name = req.body.name;

  try {
    const ressponse = await axios.post(`${firebaseAuthUrl}:signUp?key=${apiKey}`, {
      email: email,
      password: password,
      returnSecureToken: true
    });
    console.log(ressponse)
    setUpUser(ressponse.data.localId, name, email)
    res.status(200).send({
      message: ressponse.data
    });
  } catch (error) {
    res.status(500).send({
      message: error
    });
  }
});

app.post('/user/details', async (req, res) => {
  const userAuth = req.headers.auth;
  console.log(userAuth)
  var decoded = jwt_decode(userAuth);
  console.log(decoded);
  try {
    var vals = await new Promise((resolve, reject) => {
      users.child(decoded.sub).on('value', (snapshot) => {
        resolve(snapshot.val());
      }, (errorObject) => {
        console.log('The read failed: ' + errorObject.name);
        reject(errorObject);
      }); 
    });

    res.send({msg: vals})
  } catch (error) {
    console.log(error)
    res.status(500).send({
      message: error
    });
  }
});

// Define a route for logging in an existing user
app.post('/login', async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  try {
    const respon = await axios.post(`${firebaseAuthUrl}:signInWithPassword?key=${apiKey}`, {
      email: email,
      password: password,
      returnSecureToken: true
    });
    console.log(respon.data)
    res.status(200).send({
      message: respon.data,
      code: 200
    });
  } catch (error) {
    res.status(500).send({
      message: error.response.data.error.message,
      code:500
    });
  }
});

sslServer.listen(443, ()=>{
  console.log("HTTPS: server started at 443")
})

app.listen(80, () => {
  console.log('Server listening on port 80');
});
