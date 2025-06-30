const express = require('express')
const multer = require('multer')
const fs = require('fs')
const { 
    S3Client, 
    PutObjectCommand, 
    ListObjectVersionsCommand, 
    RestoreObjectCommand, 
    HeadObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand 
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const app = express()
const upload = multer({ dest: 'uploads/' })

const s3 = new S3Client({ region: 'eu-west-3' })
const bucket = 'node-app-789915097184'

// route POST pour uploader un fichier
app.post('/upload', upload.single('fichier'), async (req, res) => {
    try {
        const stream = fs.createReadStream(req.file.path)

        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: req.file.originalname,
            Body: stream,
            ServerSideEncryption: 'aws:kms' // chiffrement SSE-KMS
        })

        await s3.send(command)
        res.send('fichier uploadé avec succès')
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de l’upload')
    }
})

// route GET pour lister les fichiers du bucket
app.get('/fichiers', async (req, res) => {
    try {
        const command = new ListObjectVersionsCommand({ Bucket: bucket })
        const result = await s3.send(command)

        const versions = result.Versions?.map(v => ({
            nom: v.Key,
            versionId: v.VersionId,
            dernièreModif: v.LastModified,
            taille: v.Size,
            isLatest: v.IsLatest,
            deleteMarker: false
        })) || []

        const deleteMarkers = result.DeleteMarkers?.map(dm => ({
            nom: dm.Key,
            versionId: dm.VersionId,
            dernièreModif: dm.LastModified,
            taille: 0,
            isLatest: dm.IsLatest,
            deleteMarker: true
        })) || []

        const fichiers = [...versions, ...deleteMarkers]

        res.json({ fichiers })
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la récupération des fichiers')
    }
})

app.post('/restore/:fichier', async (req, res) => {
    const nomFichier = req.params.fichier

    try {
        // vérifier si le fichier est déjà restauré
        const head = new HeadObjectCommand({
            Bucket: bucket,
            Key: nomFichier
        })

        const meta = await s3.send(head)

        if (meta.Restore && meta.Restore.includes('ongoing-request="false"')) {
            return res.send('le fichier est déjà restauré et accessible')
        }

        if (meta.Restore && meta.Restore.includes('ongoing-request="true"')) {
            return res.send('restauration déjà en cours')
        }

        // lancer la restauration
        const restore = new RestoreObjectCommand({
            Bucket: bucket,
            Key: nomFichier,
            RestoreRequest: {
                Days: 1, // durée de restauration temporaire
                GlacierJobParameters: {
                    Tier: 'Standard'
                }
            }
        })

        await s3.send(restore)
        res.send('restauration lancée (disponible sous quelques minutes)')
    } catch (err) {
        console.error('erreur détaillée :', err)
        res.status(500).send('erreur lors de la restauration')
    }
})

app.get('/statut/:fichier', async (req, res) => {
    const nomFichier = req.params.fichier

    try {
        const head = await s3.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: nomFichier
        }))

        const statut = {
            fichier: nomFichier,
            classeStockage: head.StorageClass || 'STANDARD',
            restorationActive: head.Restore?.includes('ongoing-request="false"') || false,
            restaurationEnCours: head.Restore?.includes('ongoing-request="true"') || false
        }

        res.json(statut)
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la récupération du statut')
    }
})

app.delete('/fichier/:nom', async (req, res) => {
    const nomFichier = req.params.nom

    try {
        const command = new DeleteObjectCommand({
            Bucket: bucket,
            Key: nomFichier
        })

        await s3.send(command)
        res.send('fichier supprimé (delete marker ajouté)')
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la suppression')
    }
})

// route GET /url/:fichier
app.get('/url/:fichier', async (req, res) => {
    const nomFichier = req.params.fichier

    try {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: nomFichier
        })

        // lien valide pendant 300 secondes (5 minutes)
        const url = await getSignedUrl(s3, command, { expiresIn: 300 })

        res.json({ url })
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la génération de l’URL')
    }
})

app.delete('/fichier-definitif/:nom', async (req, res) => {
    const nom = req.params.nom

    try {
        const versions = await s3.send(new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: nom
        }))

        const version = versions.Versions?.find(v => v.Key === nom && v.IsLatest)

        if (!version) {
            return res.status(404).send('aucune version actuelle trouvée')
        }

        await s3.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: nom,
            VersionId: version.VersionId
        }))

        res.send(`la version actuelle ${version.VersionId} du fichier ${nom} a été supprimée définitivement`)
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la suppression')
    }
})

app.delete('/fichier-all-versions/:nom', async (req, res) => {
    const nom = req.params.nom

    try {
        const versions = await s3.send(new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: nom
        }))

        const allVersions = [
            ...(versions.Versions || []),
            ...(versions.DeleteMarkers || [])
        ].filter(v => v.Key === nom)

        if (allVersions.length === 0) {
            return res.status(404).send('aucune version trouvée')
        }

        for (const v of allVersions) {
            await s3.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: nom,
                VersionId: v.VersionId
            }))
        }

        res.send(`toutes les versions du fichier ${nom} ont été supprimées définitivement`)
    } catch (err) {
        console.error(err)
        res.status(500).send('erreur lors de la suppression complète')
    }
})

app.listen(80, () => {
    console.log('serveur express démarré sur http://localhost:80')
})