
WITH RECURSIVE tags(id,rest,tag) AS (
 SELECT id,tags || ',', '' FROM items WHERE kind='task' AND archived=0
 UNION ALL
 SELECT id,substr(rest,instr(rest,',')+1),trim(substr(rest,1,instr(rest,',')-1),char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))
 FROM tags WHERE rest!=''
), eligible AS (
 SELECT id FROM tags GROUP BY id
 HAVING max(tag='task-sphere:personal')=1
 AND max(lower(tag) LIKE 'jira%' OR lower(tag) LIKE 'investlink%' OR lower(tag)='task-sphere:work')=0
)
SELECT id FROM eligible WHERE id > ?1 COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT ?2
