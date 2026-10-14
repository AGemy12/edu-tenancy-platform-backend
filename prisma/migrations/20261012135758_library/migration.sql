-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('IMAGE', 'PDF', 'DOCUMENT', 'PRESENTATION', 'SPREADSHEET', 'EBOOK', 'VIDEO', 'AUDIO', 'ARCHIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('BOOK', 'EXPLANATION', 'WORKSHEET', 'SUMMARY', 'EXAM', 'OTHER');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "maxStorageMb" INTEGER NOT NULL DEFAULT 2048;

-- CreateTable
CREATE TABLE "LibraryFolder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "parentId" TEXT,
    "studentId" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "kind" "FileKind" NOT NULL,
    "category" "FileCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryFolder_ownerId_parentId_idx" ON "LibraryFolder"("ownerId", "parentId");

-- CreateIndex
CREATE INDEX "LibraryFolder_studentId_idx" ON "LibraryFolder"("studentId");

-- CreateIndex
CREATE INDEX "LibraryFolder_tenantId_idx" ON "LibraryFolder"("tenantId");

-- CreateIndex
CREATE INDEX "LibraryFile_ownerId_folderId_idx" ON "LibraryFile"("ownerId", "folderId");

-- CreateIndex
CREATE INDEX "LibraryFile_tenantId_idx" ON "LibraryFile"("tenantId");

-- CreateIndex
CREATE INDEX "LibraryFile_storageKey_idx" ON "LibraryFile"("storageKey");

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LibraryFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "LibraryFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
