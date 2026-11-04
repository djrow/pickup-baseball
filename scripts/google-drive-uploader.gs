/**
 * Google Apps Script Web App: Sunday Pickup Baseball Google Drive Uploader
 *
 * Automatically saves community photos and videos to a dedicated Google Drive folder
 * and returns direct CDN/embed links so they display in the webapp carousels without
 * filling up the Cloudflare D1 database.
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Go to https://script.google.com and click "New Project".
 * 2. Paste this code into Code.gs (replacing any existing text).
 * 3. (Optional) Set FOLDER_ID below to a specific Google Drive folder ID (leave "" for root).
 * 4. Click "Deploy" > "New Deployment".
 * 5. Select type: "Web app" (click the gear icon next to "Select type").
 * 6. Set Description: "Sunday Pickup Baseball Uploader".
 * 7. Set Execute as: "Me" (your Google account).
 * 8. Set Who has access: "Anyone" (crucial so the webapp can upload).
 * 9. Click "Deploy", authorize Google Drive permissions, and copy the Web App URL (starts with https://script.google.com/macros/s/...).
 * 10. Paste the Web App URL into the Sunday Pickup Baseball Admin Portal (under Access Control & Media Settings) or provide it here!
 */

var FOLDER_ID = ""; // Leave blank for root Drive or paste your specific folder ID

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    app: "Sunday Pickup Baseball Google Drive Uploader",
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return errorResponse("Missing POST body data.");
    }

    var data = JSON.parse(e.postData.contents);
    var action = data.action || "upload";

    if (action === "delete") {
      if (!data.fileId) return errorResponse("Missing fileId to delete.");
      var fileToDelete = DriveApp.getFileById(data.fileId);
      fileToDelete.setTrashed(true);
      return successResponse({ deleted: true, fileId: data.fileId });
    }

    if (!data.base64) {
      return errorResponse("Missing base64 file data.");
    }

    var mimeType = data.mimeType || "image/jpeg";
    var filename = data.filename || ("baseball_" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd_HHmmss") + (mimeType.indexOf("video") !== -1 ? ".mp4" : ".jpg"));
    var bytes = Utilities.base64Decode(data.base64);
    var blob = Utilities.newBlob(bytes, mimeType, filename);

    var folder = FOLDER_ID ? DriveApp.getFolderById(FOLDER_ID) : DriveApp.getRootFolder();
    var file = folder.createFile(blob);

    // Make file viewable by anyone with link
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var fileId = file.getId();

    // High-speed Google CDN photo link (lh3.googleusercontent.com/d/{id}) loads directly in <img> tags
    // For video, drive preview URL
    var isVideo = mimeType.indexOf("video") !== -1;
    var directUrl = isVideo
      ? ("https://drive.google.com/file/d/" + fileId + "/preview")
      : ("https://lh3.googleusercontent.com/d/" + fileId);

    return successResponse({
      fileId: fileId,
      fileUrl: directUrl,
      downloadUrl: "https://drive.google.com/uc?export=view&id=" + fileId,
      previewUrl: "https://drive.google.com/file/d/" + fileId + "/preview",
      filename: filename,
      mimeType: mimeType
    });
  } catch (err) {
    return errorResponse(err.toString());
  }
}

function successResponse(obj) {
  obj.success = true;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg) {
  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    error: msg
  })).setMimeType(ContentService.MimeType.JSON);
}
