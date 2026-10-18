//! Headless compilation of the shipped updater extraction method; no installer runs.
#![allow(dead_code)]
use std::{ffi::OsStr,io::Cursor,path::PathBuf};
#[derive(Debug)]
enum Error {Io(std::io::Error),Zip(zip::result::ZipError),BinaryNotFoundInArchive}
impl From<std::io::Error> for Error {fn from(e:std::io::Error)->Self{Self::Io(e)}}
impl From<zip::result::ZipError> for Error {fn from(e:zip::result::ZipError)->Self{Self::Zip(e)}}
type Result<T> = std::result::Result<T,Error>;
#[derive(Debug)]
enum WindowsUpdaterType {Nsis(PathBuf),Msi(PathBuf)}
impl WindowsUpdaterType {
 fn nsis(path:PathBuf,_temp:Option<tempfile::TempPath>)->Self{Self::Nsis(path)}
 fn msi(path:PathBuf,_temp:Option<tempfile::TempPath>)->Self{Self::Msi(path)}
}
struct Update {root:PathBuf}
impl Update {fn make_temp_dir(&self)->Result<PathBuf>{Ok(self.root.clone())}}
include!(concat!(env!("OUT_DIR"),"/extract.rs"));

#[cfg(test)]mod tests {
 use super::*;
 use std::io::Write;
 use zip::{write::SimpleFileOptions,ZipWriter};
 fn archive(name:&str,permissions:u32)->Vec<u8>{
  let mut out=ZipWriter::new(Cursor::new(Vec::new()));
  out.start_file(name,SimpleFileOptions::default().unix_permissions(permissions)).unwrap();
  out.write_all(b"synthetic installer bytes").unwrap();out.finish().unwrap().into_inner()
 }
 #[test]fn installer_exe_and_msi_contents_survive(){
  for name in ["setup.exe","setup.msi"] {
   let temp=tempfile::tempdir().unwrap();let update=Update{root:temp.path().into()};
   let result=update.extract_zip(&archive(name,0o755)).unwrap();
   let path=match result {WindowsUpdaterType::Nsis(p)=>{assert!(name.ends_with("exe"));p},WindowsUpdaterType::Msi(p)=>{assert!(name.ends_with("msi"));p}};
   assert_eq!(std::fs::read(path).unwrap(),b"synthetic installer bytes");
  }
 }
 #[test]fn malformed_and_missing_installer_are_errors(){
  let temp=tempfile::tempdir().unwrap();let update=Update{root:temp.path().into()};
  assert!(update.extract_zip(b"not a zip").is_err());
  assert!(matches!(update.extract_zip(&archive("readme.txt",0o644)),Err(Error::BinaryNotFoundInArchive)));
 }
 #[test]fn parent_traversal_cannot_write_outside_destination(){
  let temp=tempfile::tempdir().unwrap();let dest=temp.path().join("extract");std::fs::create_dir(&dest).unwrap();
  let update=Update{root:dest};let _=update.extract_zip(&archive("../escaped.exe",0o755));
  assert!(!temp.path().join("escaped.exe").exists());
 }
 #[cfg(unix)]#[test]fn extracted_installer_drops_privileged_permission_bits(){
  use std::os::unix::fs::PermissionsExt;
  let temp=tempfile::tempdir().unwrap();let update=Update{root:temp.path().into()};
  update.extract_zip(&archive("setup.exe",0o7777)).unwrap();
  assert_eq!(std::fs::metadata(temp.path().join("setup.exe")).unwrap().permissions().mode()&0o7000,0);
 }
 #[cfg(unix)]#[test]fn external_symlink_cannot_change_external_permissions_or_create_installer(){
  use std::os::unix::fs::PermissionsExt;
  let temp=tempfile::tempdir().unwrap();let outside=temp.path().join("outside.exe");std::fs::write(&outside,b"unchanged").unwrap();std::fs::set_permissions(&outside,std::fs::Permissions::from_mode(0o600)).unwrap();
  let dest=temp.path().join("extract");std::fs::create_dir(&dest).unwrap();
  let mut out=ZipWriter::new(Cursor::new(Vec::new()));
  out.add_symlink("setup.exe",outside.to_str().unwrap(),SimpleFileOptions::default().unix_permissions(0o7777)).unwrap();
  let bytes=out.finish().unwrap().into_inner();let result=Update{root:dest.clone()}.extract_zip(&bytes);
  assert!(result.is_err());
  assert!(!dest.join("setup.exe").exists());
  assert_eq!(std::fs::read(&outside).unwrap(),b"unchanged");assert_eq!(std::fs::metadata(outside).unwrap().permissions().mode()&0o777,0o600);
 }
}
